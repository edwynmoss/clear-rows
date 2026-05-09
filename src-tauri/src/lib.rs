mod csv;

use csv::{
    CsvDocument, CsvFileProfile, CsvSearchProgress, CsvSearchSummary, IndexStatus, OpenOptions,
    OpenSummary, RowBatch,
};
use parking_lot::Mutex;
use serde::Serialize;
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

    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = document_state.lock();
        let document = guard
            .as_mut()
            .ok_or_else(|| csv::CsvError::NoDocument.to_string())?;

        document
            .get_rows(start, count, column_start, column_count)
            .map_err(|err| err.to_string())
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
