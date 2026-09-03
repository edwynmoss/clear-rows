use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use serde::Serialize;
use thiserror::Error;

use rayon::prelude::*;

use super::document::prepare_utf8_source;
use super::profile_csv_path;
use super::scan::{field_bytes, field_string, BlockIndex, Field, FileMap, RowScanner};

const DEFAULT_MAX_MATCHES: usize = 500;
const MAX_MATCHES: usize = 5_000;
const VALUE_PREVIEW_BYTES: usize = 512;
/// Rows per block for the on-the-fly index used to parallelise a file scan.
const SEARCH_BLOCK_ROWS: u64 = 4_096;
/// Blocks scanned per parallel batch; progress and cancellation are checked between batches.
const SEARCH_BLOCKS_PER_BATCH: usize = 32;

#[derive(Clone, Serialize)]
pub struct CsvSearchSummary {
    pub query: String,
    pub searched_files: usize,
    pub matched_files: usize,
    pub schemas: Vec<CsvSearchFileSchema>,
    pub matches: Vec<CsvSearchMatch>,
    pub errors: Vec<CsvSearchFileError>,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
pub struct CsvSearchProgress {
    pub query: String,
    pub total_files: usize,
    pub current_file_index: usize,
    pub completed_files: usize,
    pub current_file: Option<String>,
    pub current_path: Option<String>,
    pub current_row: u64,
    pub matches: usize,
    pub matched_files: usize,
    pub errors: usize,
    pub truncated: bool,
    pub cancelled: bool,
    pub is_running: bool,
}

impl CsvSearchProgress {
    pub fn idle() -> Self {
        Self {
            query: String::new(),
            total_files: 0,
            current_file_index: 0,
            completed_files: 0,
            current_file: None,
            current_path: None,
            current_row: 0,
            matches: 0,
            matched_files: 0,
            errors: 0,
            truncated: false,
            cancelled: false,
            is_running: false,
        }
    }

    fn started(query: String, total_files: usize) -> Self {
        Self {
            query,
            total_files,
            is_running: true,
            ..Self::idle()
        }
    }
}

#[derive(Clone, Serialize)]
pub struct CsvSearchMatch {
    pub path: String,
    pub file_name: String,
    pub row_index: u64,
    pub column_index: usize,
    pub column_name: String,
    pub value: String,
    pub row_values: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct CsvSearchFileSchema {
    pub path: String,
    pub file_name: String,
    pub headers: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct CsvSearchFileError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum CsvSearchError {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("Unsupported file: {0}")]
    UnsupportedFile(String),
}

pub fn search_csv_files_with_progress<F>(
    paths: Vec<String>,
    query: String,
    max_matches: usize,
    generation: u64,
    generation_state: Arc<AtomicU64>,
    mut publish_progress: F,
) -> CsvSearchSummary
where
    F: FnMut(CsvSearchProgress),
{
    let query = query.trim().to_owned();
    let needle = SearchNeedle::new(&query);
    let max_matches = max_matches.clamp(1, MAX_MATCHES);
    let total_files = paths.len();

    let mut summary = CsvSearchSummary {
        query: query.clone(),
        searched_files: 0,
        matched_files: 0,
        schemas: Vec::new(),
        matches: Vec::new(),
        errors: Vec::new(),
        truncated: false,
        cancelled: false,
    };
    let mut progress = CsvSearchProgress::started(query, total_files);
    publish_progress(progress.clone());

    if needle.is_empty() || paths.is_empty() {
        progress.is_running = false;
        publish_progress(progress);
        return summary;
    }

    for (path_index, path) in paths.into_iter().enumerate() {
        if is_cancelled(&generation_state, generation) {
            summary.cancelled = true;
            break;
        }

        summary.searched_files += 1;
        progress.current_file_index = path_index + 1;
        progress.current_file = Some(file_name_from_path(Path::new(&path)));
        progress.current_path = Some(path.clone());
        progress.current_row = 0;
        sync_progress_from_summary(&mut progress, &summary);
        publish_progress(progress.clone());

        let before = summary.matches.len();

        let should_stop = match search_one_file(
            PathBuf::from(&path),
            &needle,
            max_matches,
            generation,
            &generation_state,
            &mut summary.schemas,
            &mut summary.matches,
            &mut progress,
            &mut publish_progress,
        ) {
            Ok(SearchFileOutcome::Complete) => false,
            Ok(SearchFileOutcome::Cancelled) => {
                summary.cancelled = true;
                true
            }
            Ok(SearchFileOutcome::Truncated) => {
                summary.truncated = true;
                true
            }
            Err(err) => {
                summary.errors.push(CsvSearchFileError {
                    path,
                    message: err.to_string(),
                });
                false
            }
        };

        if summary.matches.len() > before {
            summary.matched_files += 1;
        }

        progress.completed_files = path_index + 1;
        sync_progress_from_summary(&mut progress, &summary);
        publish_progress(progress.clone());

        if should_stop {
            break;
        }
    }

    progress.is_running = false;
    sync_progress_from_summary(&mut progress, &summary);
    publish_progress(progress);

    summary
}

pub fn default_max_matches() -> usize {
    DEFAULT_MAX_MATCHES
}

enum SearchFileOutcome {
    Complete,
    Cancelled,
    Truncated,
}

struct SearchNeedle {
    unicode_lower: String,
    ascii_lower: Option<Vec<u8>>,
}

impl SearchNeedle {
    fn new(query: &str) -> Self {
        Self {
            unicode_lower: query.to_lowercase(),
            ascii_lower: query
                .is_ascii()
                .then(|| query.bytes().map(|b| b.to_ascii_lowercase()).collect()),
        }
    }

    fn is_empty(&self) -> bool {
        self.unicode_lower.is_empty()
    }

    fn matches_bytes(&self, value: &[u8]) -> bool {
        match self.ascii_lower.as_deref() {
            Some(needle) => contains_ascii_case_insensitive(value, needle),
            None => String::from_utf8_lossy(value).to_lowercase().contains(&self.unicode_lower),
        }
    }
}

fn search_one_file(
    path: PathBuf,
    needle: &SearchNeedle,
    max_matches: usize,
    generation: u64,
    generation_state: &AtomicU64,
    schemas: &mut Vec<CsvSearchFileSchema>,
    matches: &mut Vec<CsvSearchMatch>,
    progress: &mut CsvSearchProgress,
    publish_progress: &mut impl FnMut(CsvSearchProgress),
) -> Result<SearchFileOutcome, CsvSearchError> {
    let profiled = profile_csv_path(&path)?;
    if profiled.profile.binary_like {
        return Err(CsvSearchError::UnsupportedFile(
            "File appears to be binary or uses an unsupported encoding".to_owned(),
        ));
    }

    // Same UTF-8 view the document opener uses, so UTF-16 and legacy-codepage
    // files are searchable instead of being scanned as raw bytes.
    let (read_path, read_data_start, _cache_guard) = prepare_utf8_source(&path, &profiled)?;
    let delimiter = profiled.delimiter;
    let map = FileMap::open(&read_path)?;
    let bytes = map.bytes();

    // Header row.
    let mut header_scanner = RowScanner::new(bytes, read_data_start as usize, delimiter);
    let mut fields: Vec<Field> = Vec::with_capacity(32);
    let mut scratch = Vec::new();
    if !header_scanner.next_row(&mut fields) {
        return Ok(SearchFileOutcome::Complete);
    }
    let headers: Vec<String> = fields.iter().map(|f| field_string(bytes, f, &mut scratch)).collect();

    let path_string = path.to_string_lossy().into_owned();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&path_string)
        .to_owned();

    if !schemas.iter().any(|schema| schema.path == path_string) {
        schemas.push(CsvSearchFileSchema {
            path: path_string.clone(),
            file_name: file_name.clone(),
            headers: headers.clone(),
        });
    }

    // A quick row-boundary pass gives us blocks to scan in parallel; the
    // boundary pass itself is memchr-bound and far cheaper than parsing.
    let index = BlockIndex::build(bytes, read_data_start, delimiter, SEARCH_BLOCK_ROWS);
    let ranges = index.ranges();
    let mut rows_scanned: u64 = 0;

    for batch in ranges.chunks(SEARCH_BLOCKS_PER_BATCH) {
        if is_cancelled(generation_state, generation) {
            progress.current_row = rows_scanned;
            progress.matches = matches.len();
            publish_progress(progress.clone());
            return Ok(SearchFileOutcome::Cancelled);
        }

        let found: Vec<(u64, Vec<CsvSearchMatch>)> = batch
            .par_iter()
            .map(|&(_, first_row, start, end)| {
                let end = end.min(bytes.len());
                let slice = &bytes[start.min(end)..end];
                let mut scanner = RowScanner::new(slice, 0, delimiter);
                let mut fields: Vec<Field> = Vec::with_capacity(32);
                let mut unescape = Vec::new();
                let mut hits = Vec::new();
                let mut phys = first_row;
                let mut rows = 0u64;
                while scanner.next_row(&mut fields) {
                    if phys > 0 {
                        let mut preview_row: Option<Vec<String>> = None;
                        for (column_index, field) in fields.iter().enumerate() {
                            let cell = field_bytes(slice, field, &mut unescape);
                            if !needle.matches_bytes(cell) {
                                continue;
                            }
                            let row_values = preview_row.get_or_insert_with(|| {
                                let mut tmp = Vec::new();
                                fields.iter().map(|f| truncate_preview(field_string(slice, f, &mut tmp))).collect()
                            });
                            hits.push(CsvSearchMatch {
                                path: path_string.clone(),
                                file_name: file_name.clone(),
                                row_index: phys,
                                column_index,
                                column_name: headers.get(column_index).cloned().unwrap_or_default(),
                                value: truncate_preview(String::from_utf8_lossy(cell).into_owned()),
                                row_values: row_values.clone(),
                            });
                        }
                    }
                    phys += 1;
                    rows += 1;
                }
                (rows, hits)
            })
            .collect();

        for (rows, hits) in found {
            rows_scanned += rows;
            for hit in hits {
                if matches.len() >= max_matches {
                    progress.current_row = rows_scanned;
                    progress.matches = matches.len();
                    publish_progress(progress.clone());
                    return Ok(SearchFileOutcome::Truncated);
                }
                matches.push(hit);
            }
        }

        progress.current_row = rows_scanned;
        progress.matches = matches.len();
        publish_progress(progress.clone());
    }

    Ok(SearchFileOutcome::Complete)
}

fn is_cancelled(generation_state: &AtomicU64, generation: u64) -> bool {
    generation_state.load(Ordering::SeqCst) != generation
}

fn sync_progress_from_summary(progress: &mut CsvSearchProgress, summary: &CsvSearchSummary) {
    progress.matches = summary.matches.len();
    progress.matched_files = summary.matched_files;
    progress.errors = summary.errors.len();
    progress.truncated = summary.truncated;
    progress.cancelled = summary.cancelled;
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }

    if needle.len() > haystack.len() {
        return false;
    }

    haystack.windows(needle.len()).any(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(left, right)| left.to_ascii_lowercase() == *right)
    })
}

fn file_name_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn truncate_preview(s: String) -> String {
    if s.len() <= VALUE_PREVIEW_BYTES {
        return s;
    }

    let mut idx = VALUE_PREVIEW_BYTES;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }

    let mut out = s;
    out.truncate(idx);
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn searches_multiple_csv_files() {
        let dir = std::env::temp_dir();
        let first = dir.join("dataparser_search_one.csv");
        let second = dir.join("dataparser_search_two.csv");

        fs::write(&first, "id;name\n1;Alpha\n2;Beta\n").expect("write first fixture");
        fs::write(&second, "id;name\n3;Gamma\n4;Alphabet\n").expect("write second fixture");

        let generation_state = Arc::new(AtomicU64::new(1));
        let summary = search_csv_files_with_progress(
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            "alpha".to_owned(),
            10,
            1,
            generation_state,
            |_| {},
        );

        assert!(!summary.cancelled);
        assert!(!summary.truncated);
        assert_eq!(summary.searched_files, 2);
        assert_eq!(summary.matched_files, 2);
        assert_eq!(summary.schemas.len(), 2);
        assert_eq!(summary.matches.len(), 2);
        assert_eq!(summary.matches[0].row_index, 1);
        assert_eq!(summary.matches[0].column_name, "name");
        assert_eq!(summary.matches[0].row_values, ["1", "Alpha"]);
        assert_eq!(summary.matches[1].row_index, 2);

        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn truncates_search_results_at_requested_limit() {
        let path = std::env::temp_dir().join("dataparser_search_limit.csv");
        fs::write(
            &path,
            concat!(
                "id;name\n",
                "1;Alpha\n",
                "2;Alpha Beta\n",
                "3;Alpha Gamma\n",
            ),
        )
        .expect("write fixture");

        let generation_state = Arc::new(AtomicU64::new(1));
        let summary = search_csv_files_with_progress(
            vec![path.to_string_lossy().into_owned()],
            "alpha".to_owned(),
            2,
            1,
            generation_state,
            |_| {},
        );

        assert!(summary.truncated);
        assert_eq!(summary.matches.len(), 2);
        assert_eq!(summary.matched_files, 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reports_search_progress_snapshots() {
        let path = std::env::temp_dir().join("dataparser_search_progress.csv");
        fs::write(&path, "id;name\n1;Alpha\n2;Beta\n").expect("write fixture");

        let generation_state = Arc::new(AtomicU64::new(1));
        let mut snapshots = Vec::new();
        let summary = search_csv_files_with_progress(
            vec![path.to_string_lossy().into_owned()],
            "alpha".to_owned(),
            10,
            1,
            generation_state,
            |progress| snapshots.push(progress),
        );

        assert_eq!(summary.matches.len(), 1);
        assert!(snapshots.iter().any(|progress| progress.is_running));
        let final_snapshot = snapshots.last().expect("final progress snapshot");
        assert!(!final_snapshot.is_running);
        assert_eq!(final_snapshot.matches, 1);
        assert_eq!(final_snapshot.completed_files, 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn searches_root_host_csvs_when_available() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .to_path_buf();
        let applications = root.join("cs_applications_per_host.csv");
        let assets = root.join("cs_asset_output.csv");

        if !applications.exists() || !assets.exists() {
            return;
        }

        let generation_state = Arc::new(AtomicU64::new(1));
        let summary = search_csv_files_with_progress(
            vec![
                applications.to_string_lossy().into_owned(),
                assets.to_string_lossy().into_owned(),
            ],
            "CrowdStrike".to_owned(),
            5_000,
            1,
            generation_state,
            |_| {},
        );

        assert!(!summary.cancelled);
        assert!(summary.errors.is_empty());
        assert_eq!(summary.searched_files, 2);
        assert_eq!(summary.matched_files, 2);
        assert!(!summary.matches.is_empty());
        assert!(summary
            .matches
            .iter()
            .any(|m| m.file_name == "cs_applications_per_host.csv"));
        assert!(summary
            .matches
            .iter()
            .any(|m| m.file_name == "cs_asset_output.csv"));
    }
}
