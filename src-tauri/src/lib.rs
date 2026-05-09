mod csv;

use csv::{
    build_sort, CsvDocument, CsvFileProfile, CsvSearchProgress, CsvSearchSummary, IndexStatus,
    OpenOptions, OpenSummary, RowBatch, SortBuildOptions, SortDirection, SortState, SortStatus,
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
    // Opening a new document invalidates any prior sort. Bump the sort
    // generation so an in-flight sort job won't write stale state into the
    // freshly-opened file's session.
    state.sort_generation.fetch_add(1, Ordering::SeqCst);
    state.sort_state.lock().clear();
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

    tauri::async_runtime::spawn_blocking(move || {
        // Snapshot the current permutation slice we need *before* we lock the
        // document, so we don't hold both mutexes at once. The permutation is
        // only mutated when a sort completes (under the same lock) so a clone
        // here is the only safe path while the document is borrowed mut.
        let permutation_slice: Option<Vec<u64>> = {
            let guard = sort_state.lock();
            guard.permutation.as_ref().map(|perm| {
                let start_usize = usize::try_from(start).unwrap_or(usize::MAX);
                if start_usize >= perm.len() {
                    Vec::new()
                } else {
                    let end = start_usize.saturating_add(count).min(perm.len());
                    perm[start_usize..end].to_vec()
                }
            })
        };

        let mut guard = document_state.lock();
        let document = guard
            .as_mut()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        match permutation_slice {
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
