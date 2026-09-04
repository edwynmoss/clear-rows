mod csv;

use csv::{
    build_export, build_filter, build_sort, CsvDocument, CsvFileProfile, CsvSearchProgress, SortKey,
    CsvSearchSummary, ExportBuildOptions, ExportState, ExportStatus, FilterBuildOptions,
    ColumnStats, ColumnStatsOptions, compute_column_stats, FilterState, FilterStatus, IndexStatus, OpenOptions, OpenSummary, RowBatch, SortBuildOptions,
    SortState, SortStatus,
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
    export_generation: Arc<AtomicU64>,
    export_state: Arc<Mutex<ExportState>>,
    /// Cached composition of the active filter mask over the active sort
    /// permutation (visible order -> physical data index). Keyed by pointer
    /// identity of the two inputs, so it is rebuilt only when either changes.
    composed_view: Arc<Mutex<Option<ComposedView>>>,
    /// Bumped per column-stats request so a newer request cancels an older one.
    stats_generation: Arc<AtomicU64>,
}

struct ComposedView {
    mask: Arc<Vec<u64>>,
    perm: Arc<Vec<u64>>,
    visible: Arc<Vec<u64>>,
}

/// Visible-order physical indices for a filter mask applied over a sort
/// permutation, computed once and shared until either input changes.
fn composed_visible(
    cache: &Mutex<Option<ComposedView>>,
    mask: &Arc<Vec<u64>>,
    perm: &Arc<Vec<u64>>,
) -> Arc<Vec<u64>> {
    if let Some(entry) = cache.lock().as_ref() {
        if Arc::ptr_eq(&entry.mask, mask) && Arc::ptr_eq(&entry.perm, perm) {
            return Arc::clone(&entry.visible);
        }
    }
    let visible: Vec<u64> = perm
        .iter()
        .copied()
        .filter(|phys| mask.binary_search(phys).is_ok())
        .collect();
    let visible = Arc::new(visible);
    *cache.lock() = Some(ComposedView {
        mask: Arc::clone(mask),
        perm: Arc::clone(perm),
        visible: Arc::clone(&visible),
    });
    visible
}

#[tauri::command]
async fn open_csv(
    path: String,
    delimiter_override: Option<String>,
    encoding_override: Option<String>,
    header_override: Option<String>,
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
        header_override,
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
    state.export_generation.fetch_add(1, Ordering::SeqCst);
    state.export_state.lock().clear();
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
    let composed_cache = Arc::clone(&state.composed_view);

    tauri::async_runtime::spawn_blocking(move || {
        // Snapshot filter mask and sort permutation up front (Arc clones, no
        // copying) so we don't hold either lock while reading the document.
        let filter_mask: Option<Arc<Vec<u64>>> = filter_state.lock().mask.clone();
        let sort_perm: Option<Arc<Vec<u64>>> = sort_state.lock().permutation.clone();

        let physical_slice: Option<Vec<u64>> = match (filter_mask, sort_perm) {
            (None, None) => None,
            (None, Some(perm)) => Some(slice_into(&perm, start, count)),
            (Some(mask), None) => Some(slice_into(&mask, start, count)),
            (Some(mask), Some(perm)) => {
                let visible = composed_visible(&composed_cache, &mask, &perm);
                Some(slice_into(&visible, start, count))
            }
        };

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

fn slice_into(source: &[u64], start: u64, count: usize) -> Vec<u64> {
    let start_usize = usize::try_from(start).unwrap_or(usize::MAX);
    if start_usize >= source.len() {
        return Vec::new();
    }
    let end = start_usize.saturating_add(count).min(source.len());
    source[start_usize..end].to_vec()
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
    keys: Vec<SortKey>,
    state: State<'_, AppState>,
) -> Result<SortStatus, String> {
    let document_state = Arc::clone(&state.document);
    let sort_state = Arc::clone(&state.sort_state);
    let sort_generation = Arc::clone(&state.sort_generation);

    if keys.is_empty() {
        return Err("At least one sort key is required.".to_owned());
    }

    let prepared = {
        let guard = document_state.lock();
        let document = guard
            .as_ref()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        if !document.is_indexing_complete() {
            return Err("Indexing is still running. Wait for it to finish before sorting.".to_owned());
        }

        let headers_len = document.summarize().headers.len();
        for key in &keys {
            if key.column >= headers_len {
                return Err("Column index out of range.".to_owned());
            }
        }

        SortStartParams {
            source_path: document.read_path().to_path_buf(),
            data_start: document.read_data_start(),
            delimiter: document.delimiter(),
            total_rows: document.data_row_count(),
            blocks: document.block_index(),
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
            keys: keys.clone(),
            rows_scanned: 0,
            total_rows: prepared.total_rows,
            error: None,
        };
    }

    let build_options = SortBuildOptions {
        source_path: prepared.source_path,
        data_start: prepared.data_start,
        delimiter: prepared.delimiter,
        keys,
        blocks: Some(prepared.blocks),
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
    blocks: csv::scan::BlockIndex,
}

struct FilterStartParams {
    source_path: PathBuf,
    data_start: u64,
    delimiter: u8,
    total_rows: u64,
    headers: Vec<String>,
    blocks: csv::scan::BlockIndex,
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
            return Err("Indexing is still running. Wait for it to finish before filtering.".to_owned());
        }

        FilterStartParams {
            source_path: document.read_path().to_path_buf(),
            data_start: document.read_data_start(),
            delimiter: document.delimiter(),
            total_rows: document.data_row_count(),
            headers: document.summarize().headers,
            blocks: document.block_index(),
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
        headers: prepared.headers,
        blocks: Some(prepared.blocks),
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

/// Statistics for one column over the rows currently in view (the active
/// filter, if any). Sorting does not change the answer, so it is ignored.
#[tauri::command]
async fn column_stats(
    column: usize,
    top_n: Option<usize>,
    state: State<'_, AppState>,
) -> Result<ColumnStats, String> {
    let document_state = Arc::clone(&state.document);
    let filter_state = Arc::clone(&state.filter_state);
    let stats_generation = Arc::clone(&state.stats_generation);

    let (options, generation) = {
        let guard = document_state.lock();
        let document = guard
            .as_ref()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;
        if !document.is_indexing_complete() {
            return Err("Indexing is still running. Wait for it to finish before inspecting a column.".to_owned());
        }
        let profile = document
            .column_types()
            .get(column)
            .copied()
            .ok_or_else(|| format!("Column index {} is out of range.", column))?;
        let generation = stats_generation.fetch_add(1, Ordering::SeqCst) + 1;
        (
            ColumnStatsOptions {
                source_path: document.read_path().to_path_buf(),
                data_start: document.read_data_start(),
                delimiter: document.delimiter(),
                blocks: Some(document.block_index()),
                column,
                profile,
                mask: filter_state.lock().mask.clone(),
                top_n: top_n.unwrap_or(12).clamp(1, 200),
                generation,
                generation_state: Arc::clone(&stats_generation),
            },
            generation,
        )
    };
    let _ = generation;

    tauri::async_runtime::spawn_blocking(move || compute_column_stats(options))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
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

struct ExportStartParams {
    target_path: PathBuf,
    /// Headers projected through `column_indices`.
    headers: Vec<String>,
    delimiter: u8,
    visible_indices: Vec<u64>,
    /// Physical column indices to include in the export, in output order.
    column_indices: Vec<usize>,
    read_path: PathBuf,
    blocks: csv::scan::BlockIndex,
}

#[tauri::command]
async fn start_csv_export(
    target_path: String,
    column_indices: Option<Vec<usize>>,
    state: State<'_, AppState>,
) -> Result<ExportStatus, String> {
    let document_state = Arc::clone(&state.document);
    let sort_state = Arc::clone(&state.sort_state);
    let filter_state = Arc::clone(&state.filter_state);
    let export_state = Arc::clone(&state.export_state);
    let export_generation = Arc::clone(&state.export_generation);

    let target_path = PathBuf::from(target_path.trim());
    if target_path.as_os_str().is_empty() {
        return Err("Target path is empty.".to_owned());
    }

    let prepared = {
        let guard = document_state.lock();
        let document = guard
            .as_ref()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        if !document.is_indexing_complete() {
            return Err("Indexing is still running. Wait for it to finish before exporting.".to_owned());
        }

        let all_headers = document.summarize().headers;
        let header_count = all_headers.len();

        // Default to every column (in original order) when the caller
        // doesn't specify a subset.
        let columns: Vec<usize> = match column_indices {
            None => (0..header_count).collect(),
            Some(indices) => {
                if indices.is_empty() {
                    return Err("Pick at least one column to export.".to_owned());
                }
                if let Some(&out_of_range) = indices.iter().find(|&&i| i >= header_count) {
                    return Err(format!(
                        "Column index {} is out of range (have {} columns).",
                        out_of_range, header_count
                    ));
                }
                indices
            }
        };

        let projected_headers: Vec<String> =
            columns.iter().map(|&i| all_headers[i].clone()).collect();

        // Snapshot filter mask + sort permutation under the same view we'll
        // export. If either changes mid-export the generation bump cancels us.
        let filter_mask: Option<Arc<Vec<u64>>> = filter_state.lock().mask.clone();
        let sort_perm: Option<Arc<Vec<u64>>> = sort_state.lock().permutation.clone();
        let total_rows = document.data_row_count();

        let visible_indices = match (filter_mask, sort_perm) {
            (None, None) => (0..total_rows).collect::<Vec<u64>>(),
            (None, Some(perm)) => (*perm).clone(),
            (Some(mask), None) => (*mask).clone(),
            (Some(mask), Some(perm)) => (*composed_visible(&state.composed_view, &mask, &perm)).clone(),
        };

        ExportStartParams {
            target_path: target_path.clone(),
            headers: projected_headers,
            delimiter: document.delimiter(),
            visible_indices,
            column_indices: columns,
            read_path: document.read_path().to_path_buf(),
            blocks: document.block_index(),
        }
    };

    let generation = export_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let total_rows = prepared.visible_indices.len() as u64;

    {
        let mut s = export_state.lock();
        s.status = ExportStatus {
            is_running: true,
            is_complete: false,
            target_path: Some(target_path.to_string_lossy().into_owned()),
            rows_written: 0,
            total_rows,
            error: None,
        };
    }

    let read_path = prepared.read_path.clone();
    let blocks = prepared.blocks.clone();
    let delimiter = prepared.delimiter;
    let all_visible = prepared.visible_indices.clone();
    let mut lookup: Option<(csv::scan::FileMap, Vec<u64>, Vec<usize>)> = None;
    let state_for_error = Arc::clone(&export_state);
    let generation_for_error = Arc::clone(&export_generation);
    let column_indices = prepared.column_indices;

    let build_options = ExportBuildOptions {
        target_path: prepared.target_path,
        headers: prepared.headers,
        delimiter: prepared.delimiter,
        visible_indices: prepared.visible_indices,
        generation,
        generation_state: Arc::clone(&export_generation),
        state: Arc::clone(&export_state),
        fetch_chunk: move |_visible_start: u64, indices: &[u64]| {
            // First call: map the source and resolve the byte offset of every
            // exported row in one parallel sweep. Rows are then read straight
            // from the map, so a sorted or filtered export costs one pass
            // over the file plus the writes, and never touches the document lock.
            let (map, wanted, offsets) = lookup.get_or_insert_with(|| {
                let map = csv::scan::FileMap::open(&read_path).expect("export source is readable");
                let mut wanted = all_visible.clone();
                wanted.sort_unstable();
                wanted.dedup();
                let offsets = csv::scan::row_offsets(map.bytes(), &blocks, delimiter, &wanted);
                (map, wanted, offsets)
            });
            let bytes = map.bytes();
            let mut out: Vec<Vec<String>> = Vec::with_capacity(indices.len());
            let mut fields = Vec::with_capacity(32);
            let mut scratch = Vec::new();
            for &phys in indices {
                let offset = wanted
                    .binary_search(&phys)
                    .ok()
                    .map(|i| offsets[i])
                    .unwrap_or(bytes.len());
                let mut projected = Vec::with_capacity(column_indices.len());
                let mut scanner = csv::scan::RowScanner::new(bytes, offset, delimiter);
                if offset < bytes.len() && scanner.next_row(&mut fields) {
                    for &col in &column_indices {
                        projected.push(
                            fields
                                .get(col)
                                .map(|f| csv::scan::field_string(bytes, f, &mut scratch))
                                .unwrap_or_default(),
                        );
                    }
                } else {
                    projected.resize(column_indices.len(), String::new());
                }
                out.push(projected);
            }
            Ok(out)
        },
    };

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = build_export(build_options) {
            if generation_for_error.load(Ordering::SeqCst) == generation {
                let mut s = state_for_error.lock();
                s.status.is_running = false;
                s.status.is_complete = false;
                s.status.error = Some(err.to_string());
            }
        }
    });

    let status = export_state.lock().status.clone();
    Ok(status)
}

#[tauri::command]
fn csv_export_status(state: State<'_, AppState>) -> ExportStatus {
    let status = state.export_state.lock().status.clone();
    status
}

#[tauri::command]
fn cancel_csv_export(state: State<'_, AppState>) -> ExportStatus {
    state.export_generation.fetch_add(1, Ordering::SeqCst);
    let mut s = state.export_state.lock();
    if s.status.is_running {
        s.status.is_running = false;
        s.status.is_complete = false;
        s.status.error = Some("Cancelled.".to_owned());
    }
    let status = s.status.clone();
    drop(s);
    status
}

#[tauri::command]
fn clear_csv_export(state: State<'_, AppState>) -> ExportStatus {
    state.export_generation.fetch_add(1, Ordering::SeqCst);
    let mut s = state.export_state.lock();
    s.clear();
    let status = s.status.clone();
    drop(s);
    status
}

#[tauri::command]
fn startup_csv_path() -> Option<String> {
    // Double-click / "Open with" / `clear-rows file.csv` all arrive as argv[1].
    let from_args = std::env::args_os()
        .skip(1)
        .map(std::path::PathBuf::from)
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned());
    from_args.or_else(|| {
        std::env::var("CLEAR_ROWS_OPEN_CSV")
            .or_else(|_| std::env::var("DATAPARSER_OPEN_CSV"))
            .ok()
            .map(|path| path.trim().to_owned())
            .filter(|path| !path.is_empty())
    })
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
            export_generation: Arc::new(AtomicU64::new(0)),
            export_state: Arc::new(Mutex::new(ExportState::idle())),
            composed_view: Arc::new(Mutex::new(None)),
            stats_generation: Arc::new(AtomicU64::new(0)),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            column_stats,
            clear_csv_filter,
            start_csv_export,
            csv_export_status,
            cancel_csv_export,
            clear_csv_export,
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
