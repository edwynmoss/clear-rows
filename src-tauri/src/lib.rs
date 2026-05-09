mod csv;

use csv::{
    build_filter, build_sort, CsvDocument, CsvFileProfile, CsvSearchProgress, CsvSearchSummary,
    FilterBuildOptions, FilterState, FilterStatus, IndexStatus, OpenOptions, OpenSummary, RowBatch,
    SortBuildOptions, SortDirection, SortState, SortStatus,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::State;

const INITIAL_INDEX_ROWS: usize = 2_048;
const BACKGROUND_INDEX_CHUNK_ROWS: usize = 4_096;

#[derive(Clone, Serialize)]
struct CsvFileProfileResult {
    path: String,
    profile: Option<CsvFileProfile>,
    error: Option<String>,
}

pub struct AppState {
    document: Arc<Mutex<Option<CsvDocument>>>,
    index_generation: Arc<AtomicU64>,
    search_generation: Arc<AtomicU64>,
    search_progress: Arc<Mutex<CsvSearchProgress>>,
    sort_generation: Arc<AtomicU64>,
    sort_state: Arc<Mutex<SortState>>,
    filter_generation: Arc<AtomicU64>,
    filter_state: Arc<Mutex<FilterState>>,
}

#[tauri::command]
async fn open_csv(
    path: String,
    delimiter_override: Option<String>,
    encoding_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<OpenSummary, String> {
    let document_state = Arc::clone(&state.document);
    let generation_state = Arc::clone(&state.index_generation);
    let generation = generation_state.fetch_add(1, Ordering::SeqCst) + 1;

    let options = OpenOptions {
        delimiter_override: delimiter_override
            .as_deref()
            .and_then(|value| value.chars().next())
            .and_then(|c| u8::try_from(c as u32).ok()),
        encoding_override,
    };

    let (document, summary) = tauri::async_runtime::spawn_blocking(move || {
        let document =
            CsvDocument::open_progressive_with_options(path, INITIAL_INDEX_ROWS, options)?;
        let summary = document.summarize();
        Ok::<_, csv::CsvError>((document, summary))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;

    *document_state.lock() = Some(document);
    // Opening a new document invalidates any prior sort or filter. Bump both
    // generations so in-flight jobs don't write stale state into the
    // freshly-opened file's session.
    state.sort_generation.fetch_add(1, Ordering::SeqCst);
    state.sort_state.lock().clear();
    state.filter_generation.fetch_add(1, Ordering::SeqCst);
    state.filter_state.lock().clear();
    spawn_background_indexer(document_state, generation_state, generation);

    Ok(summary)
}

#[tauri::command]
async fn get_csv_rows(
    start: u64,
    count: usize,
    column_start: usize,
    column_count: usize,
    state: State<'_, AppState>,
) -> Result<RowBatch, String> {
    let document_state = Arc::clone(&state.document);
    let sort_state = Arc::clone(&state.sort_state);
    let filter_state = Arc::clone(&state.filter_state);

    tauri::async_runtime::spawn_blocking(move || {
        // Snapshot filter mask and sort permutation up front so we don't
        // hold either lock while reading the document.
        let filter_mask: Option<Vec<u64>> = filter_state.lock().mask.clone();
        let sort_perm: Option<Vec<u64>> = sort_state.lock().permutation.clone();

        let physical_slice: Option<Vec<u64>> =
            compose_visible_slice(filter_mask, sort_perm, start, count);

        let mut guard = document_state.lock();
        let document = guard
            .as_mut()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        match physical_slice {
            Some(slice) => document
                .get_rows_at_physical_data_indices(start, &slice, column_start, column_count)
                .map_err(|err| err.to_string()),
            None => document
                .get_rows(start, count, column_start, column_count)
                .map_err(|err| err.to_string()),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Resolve the requested page of *visible* rows to a slice of physical row
/// indices, given the active filter and sort. Returns `None` when no filter
/// or sort is active (caller falls back to physical-row reads).
fn compose_visible_slice(
    filter_mask: Option<Vec<u64>>,
    sort_perm: Option<Vec<u64>>,
    start: u64,
    count: usize,
) -> Option<Vec<u64>> {
    match (filter_mask, sort_perm) {
        (None, None) => None,
        (None, Some(perm)) => Some(slice_into(&perm, start, count)),
        (Some(mask), None) => Some(slice_into(&mask, start, count)),
        (Some(mask), Some(perm)) => Some(compose_filter_over_sort(&mask, &perm, start, count)),
    }
}

fn slice_into(source: &[u64], start: u64, count: usize) -> Vec<u64> {
    let start_usize = usize::try_from(start).unwrap_or(usize::MAX);
    if start_usize >= source.len() {
        return Vec::new();
    }
    let end = start_usize.saturating_add(count).min(source.len());
    source[start_usize..end].to_vec()
}

/// Walk `sort_perm` in sorted order, keeping only entries whose physical
/// index is in `mask`, and return the `[start..start+count)` window. `mask`
/// must be sorted ascending (it always is — the filter scanner appends rows
/// in physical order).
fn compose_filter_over_sort(mask: &[u64], sort_perm: &[u64], start: u64, count: usize) -> Vec<u64> {
    let mut out = Vec::with_capacity(count);
    let mut visible_idx: u64 = 0;
    for &phys in sort_perm.iter() {
        if mask.binary_search(&phys).is_err() {
            continue;
        }
        if visible_idx >= start {
            out.push(phys);
            if out.len() == count {
                break;
            }
        }
        visible_idx += 1;
    }
    out
}

#[tauri::command]
fn csv_index_status(state: State<'_, AppState>) -> Result<IndexStatus, String> {
    let guard = state.document.lock();
    let document = guard
        .as_ref()
        .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

    Ok(document.index_status())
}

#[tauri::command]
async fn search_csv_files(
    paths: Vec<String>,
    query: String,
    max_matches: Option<usize>,
    state: State<'_, AppState>,
) -> Result<CsvSearchSummary, String> {
    let generation_state = Arc::clone(&state.search_generation);
    let progress_state = Arc::clone(&state.search_progress);
    let generation = generation_state.fetch_add(1, Ordering::SeqCst) + 1;
    let limit = max_matches.unwrap_or_else(csv::default_max_matches);

    tauri::async_runtime::spawn_blocking(move || {
        csv::search_csv_files_with_progress(
            paths,
            query,
            limit,
            generation,
            generation_state,
            move |progress| {
                *progress_state.lock() = progress;
            },
        )
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn profile_csv_files(paths: Vec<String>) -> Result<Vec<CsvFileProfileResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(
                |path| match csv::profile_csv_path(std::path::Path::new(&path)) {
                    Ok(profiled) => CsvFileProfileResult {
                        path,
                        profile: Some(profiled.profile),
                        error: None,
                    },
                    Err(err) => CsvFileProfileResult {
                        path,
                        profile: None,
                        error: Some(err.to_string()),
                    },
                },
            )
            .collect()
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn csv_search_progress(state: State<'_, AppState>) -> CsvSearchProgress {
    state.search_progress.lock().clone()
}

#[tauri::command]
fn cancel_csv_search(state: State<'_, AppState>) -> CsvSearchProgress {
    state.search_generation.fetch_add(1, Ordering::SeqCst);

    let mut progress = state.search_progress.lock();
    if progress.is_running {
        progress.is_running = false;
        progress.cancelled = true;
    }

    progress.clone()
}

#[tauri::command]
async fn start_csv_sort(
    column_index: usize,
    direction: SortDirection,
    state: State<'_, AppState>,
) -> Result<SortStatus, String> {
    let document_state = Arc::clone(&state.document);
    let sort_state = Arc::clone(&state.sort_state);
    let sort_generation = Arc::clone(&state.sort_generation);

    let prepared = {
        let guard = document_state.lock();
        let document = guard
            .as_ref()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        if !document.is_indexing_complete() {
            return Err("Indexing in progress — wait for it to finish before sorting.".to_owned());
        }

        if column_index >= document.summarize().headers.len() {
            return Err("Column index out of range.".to_owned());
        }

        SortStartParams {
            source_path: document.read_path().to_path_buf(),
            data_start: document.read_data_start(),
            delimiter: document.delimiter(),
            total_rows: document.data_row_count(),
        }
    };

    let generation = sort_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let spill_dir = std::env::temp_dir()
        .join("clear-rows")
        .join("sort")
        .join(format!("{}-{}", std::process::id(), generation));

    {
        let mut s = sort_state.lock();
        s.permutation = None;
        s.status = SortStatus {
            is_sorting: true,
            is_ready: false,
            column: Some(column_index),
            direction: Some(direction),
            rows_scanned: 0,
            total_rows: prepared.total_rows,
            error: None,
        };
    }

    let build_options = SortBuildOptions {
        source_path: prepared.source_path,
        data_start: prepared.data_start,
        delimiter: prepared.delimiter,
        column: column_index,
        direction,
        spill_dir,
        generation,
        generation_state: Arc::clone(&sort_generation),
        state: Arc::clone(&sort_state),
    };

    let state_for_error = Arc::clone(&sort_state);
    let generation_for_error = Arc::clone(&sort_generation);

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = build_sort(build_options) {
            // Only publish the error if we're still the active sort. A newer
            // sort or document open would have bumped the generation.
            if generation_for_error.load(Ordering::SeqCst) == generation {
                let mut s = state_for_error.lock();
                s.permutation = None;
                s.status.is_sorting = false;
                s.status.is_ready = false;
                s.status.error = Some(err.to_string());
            }
        }
    });

    let status = sort_state.lock().status.clone();
    Ok(status)
}

#[tauri::command]
fn csv_sort_status(state: State<'_, AppState>) -> SortStatus {
    let status = state.sort_state.lock().status.clone();
    status
}

#[tauri::command]
fn clear_csv_sort(state: State<'_, AppState>) -> SortStatus {
    state.sort_generation.fetch_add(1, Ordering::SeqCst);
    let mut s = state.sort_state.lock();
    s.clear();
    let status = s.status.clone();
    drop(s);
    status
}

struct SortStartParams {
    source_path: PathBuf,
    data_start: u64,
    delimiter: u8,
    total_rows: u64,
}

struct FilterStartParams {
    source_path: PathBuf,
    data_start: u64,
    delimiter: u8,
    total_rows: u64,
}

#[tauri::command]
async fn start_csv_filter(
    query: String,
    state: State<'_, AppState>,
) -> Result<FilterStatus, String> {
    let document_state = Arc::clone(&state.document);
    let filter_state = Arc::clone(&state.filter_state);
    let filter_generation = Arc::clone(&state.filter_generation);

    let trimmed = query.trim().to_owned();
    if trimmed.is_empty() {
        // An empty/whitespace query is treated as "clear filter".
        filter_generation.fetch_add(1, Ordering::SeqCst);
        let mut s = filter_state.lock();
        s.clear();
        let status = s.status.clone();
        drop(s);
        return Ok(status);
    }

    let prepared = {
        let guard = document_state.lock();
        let document = guard
            .as_ref()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        if !document.is_indexing_complete() {
            return Err("Indexing in progress — wait for it to finish before filtering.".to_owned());
        }

        FilterStartParams {
            source_path: document.read_path().to_path_buf(),
            data_start: document.read_data_start(),
            delimiter: document.delimiter(),
            total_rows: document.data_row_count(),
        }
    };

    let generation = filter_generation.fetch_add(1, Ordering::SeqCst) + 1;

    {
        let mut s = filter_state.lock();
        s.mask = None;
        s.status = FilterStatus {
            is_filtering: true,
            is_ready: false,
            query: Some(trimmed.clone()),
            rows_scanned: 0,
            total_rows: prepared.total_rows,
            matched_rows: 0,
            error: None,
        };
    }

    let build_options = FilterBuildOptions {
        source_path: prepared.source_path,
        data_start: prepared.data_start,
        delimiter: prepared.delimiter,
        query: trimmed,
        total_rows: prepared.total_rows,
        generation,
        generation_state: Arc::clone(&filter_generation),
        state: Arc::clone(&filter_state),
    };

    let state_for_error = Arc::clone(&filter_state);
    let generation_for_error = Arc::clone(&filter_generation);

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = build_filter(build_options) {
            if generation_for_error.load(Ordering::SeqCst) == generation {
                let mut s = state_for_error.lock();
                s.mask = None;
                s.status.is_filtering = false;
                s.status.is_ready = false;
                s.status.error = Some(err.to_string());
            }
        }
    });

    let status = filter_state.lock().status.clone();
    Ok(status)
}

#[tauri::command]
fn csv_filter_status(state: State<'_, AppState>) -> FilterStatus {
    let status = state.filter_state.lock().status.clone();
    status
}

#[tauri::command]
fn clear_csv_filter(state: State<'_, AppState>) -> FilterStatus {
    state.filter_generation.fetch_add(1, Ordering::SeqCst);
    let mut s = state.filter_state.lock();
    s.clear();
    let status = s.status.clone();
    drop(s);
    status
}

#[tauri::command]
fn startup_csv_path() -> Option<String> {
    std::env::var("CLEAR_ROWS_OPEN_CSV")
        .or_else(|_| std::env::var("DATAPARSER_OPEN_CSV"))
        .ok()
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            document: Arc::new(Mutex::new(None)),
            index_generation: Arc::new(AtomicU64::new(0)),
            search_generation: Arc::new(AtomicU64::new(0)),
            search_progress: Arc::new(Mutex::new(CsvSearchProgress::idle())),
            sort_generation: Arc::new(AtomicU64::new(0)),
            sort_state: Arc::new(Mutex::new(SortState::idle())),
            filter_generation: Arc::new(AtomicU64::new(0)),
            filter_state: Arc::new(Mutex::new(FilterState::idle())),
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_csv,
            get_csv_rows,
            csv_index_status,
            search_csv_files,
            profile_csv_files,
            csv_search_progress,
            cancel_csv_search,
            start_csv_sort,
            csv_sort_status,
            clear_csv_sort,
            start_csv_filter,
            csv_filter_status,
            clear_csv_filter,
            startup_csv_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn spawn_background_indexer(
    document_state: Arc<Mutex<Option<CsvDocument>>>,
    generation_state: Arc<AtomicU64>,
    generation: u64,
) {
    tauri::async_runtime::spawn_blocking(move || loop {
        if generation_state.load(Ordering::SeqCst) != generation {
            break;
        }

        let result = {
            let mut guard = document_state.lock();
            if generation_state.load(Ordering::SeqCst) != generation {
                break;
            }

            let Some(document) = guard.as_mut() else {
                break;
            };

            if document.is_indexing_complete() {
                break;
            }

            document.index_next_chunk(BACKGROUND_INDEX_CHUNK_ROWS)
        };

        match result {
            Ok(true) => break,
            Ok(false) => std::thread::yield_now(),
            Err(err) => {
                if generation_state.load(Ordering::SeqCst) == generation {
                    if let Some(document) = document_state.lock().as_mut() {
                        document.mark_index_error(err.to_string());
                    }
                }
                break;
            }
        }
    });
}
