use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use super::CsvError;

mod scan;

use scan::scan_filter;

/// How often (in rows) the scanner publishes progress to the shared status.
const PROGRESS_UPDATE_INTERVAL: u64 = 4_096;

#[derive(Clone, Default, Serialize)]
pub struct FilterStatus {
    pub is_filtering: bool,
    pub is_ready: bool,
    pub query: Option<String>,
    pub rows_scanned: u64,
    pub total_rows: u64,
    pub matched_rows: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct FilterState {
    pub status: FilterStatus,
    /// Sorted physical (header-excluded) row indices that match the active
    /// filter. `None` means "no filter active" — every row is visible.
    pub mask: Option<Vec<u64>>,
}

impl FilterState {
    pub fn idle() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.status = FilterStatus::default();
        self.mask = None;
    }
}

pub struct FilterBuildOptions {
    pub source_path: PathBuf,
    pub data_start: u64,
    pub delimiter: u8,
    pub query: String,
    pub total_rows: u64,
    pub generation: u64,
    pub generation_state: Arc<AtomicU64>,
    pub state: Arc<Mutex<FilterState>>,
}

pub fn build_filter(options: FilterBuildOptions) -> Result<(), CsvError> {
    let FilterBuildOptions {
        source_path,
        data_start,
        delimiter,
        query,
        total_rows,
        generation,
        generation_state,
        state,
    } = options;

    let needle = query.to_lowercase();
    if needle.is_empty() {
        // An empty filter is equivalent to no filter; clear and exit.
        if is_active(&generation_state, generation) {
            state.lock().clear();
        }
        return Ok(());
    }

    let mask = scan_filter(
        &source_path,
        data_start,
        delimiter,
        &needle,
        |scanned, matched| {
            if !is_active(&generation_state, generation) {
                return false;
            }
            if scanned % PROGRESS_UPDATE_INTERVAL == 0 {
                let mut s = state.lock();
                s.status.rows_scanned = scanned;
                s.status.matched_rows = matched;
            }
            true
        },
    )?;

    if !is_active(&generation_state, generation) {
        return Ok(());
    }

    let matched_rows = mask.len() as u64;
    let mut s = state.lock();
    s.mask = Some(mask);
    s.status.is_filtering = false;
    s.status.is_ready = true;
    s.status.query = Some(query);
    s.status.rows_scanned = total_rows;
    s.status.total_rows = total_rows;
    s.status.matched_rows = matched_rows;
    s.status.error = None;
    Ok(())
}

fn is_active(generation_state: &Arc<AtomicU64>, generation: u64) -> bool {
    generation_state.load(AtomicOrdering::SeqCst) == generation
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write_fixture(name: &str, contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(name);
        fs::write(&path, contents).expect("write fixture");
        path
    }

    fn run_build(path: &Path, query: &str, delimiter: u8, total_rows: u64) -> Vec<u64> {
        let state = Arc::new(Mutex::new(FilterState::idle()));
        let generation_state = Arc::new(AtomicU64::new(1));

        build_filter(FilterBuildOptions {
            source_path: path.to_path_buf(),
            data_start: 0,
            delimiter,
            query: query.to_owned(),
            total_rows,
            generation: 1,
            generation_state,
            state: Arc::clone(&state),
        })
        .expect("build filter");

        let mask = state.lock().mask.clone().unwrap_or_default();
        mask
    }

    #[test]
    fn matches_substring_case_insensitively_across_columns() {
        let path = write_fixture(
            "clear_rows_filter_basic.csv",
            "name,city\nAlice,Cape Town\nBob,Durban\nCharlie,CAPE TOWN\nDelta,Pretoria\n",
        );

        // "cape" should hit rows 0 and 2 only.
        let mask = run_build(&path, "cape", b',', 4);
        assert_eq!(mask, vec![0, 2]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn empty_query_clears_filter() {
        let path = write_fixture(
            "clear_rows_filter_empty.csv",
            "name\nA\nB\nC\n",
        );

        let state = Arc::new(Mutex::new(FilterState::idle()));
        let generation_state = Arc::new(AtomicU64::new(1));
        // Pre-populate mask so we can assert clear() ran.
        state.lock().mask = Some(vec![0]);

        build_filter(FilterBuildOptions {
            source_path: path.to_path_buf(),
            data_start: 0,
            delimiter: b',',
            query: String::new(),
            total_rows: 3,
            generation: 1,
            generation_state,
            state: Arc::clone(&state),
        })
        .expect("build filter");

        assert!(state.lock().mask.is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn no_matches_yields_empty_mask() {
        let path = write_fixture(
            "clear_rows_filter_nomatch.csv",
            "name\nAlice\nBob\nCharlie\n",
        );

        let mask = run_build(&path, "zzz", b',', 3);
        assert!(mask.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn mask_is_returned_in_ascending_physical_order() {
        let path = write_fixture(
            "clear_rows_filter_order.csv",
            "id,tag\n1,red\n2,green\n3,RED\n4,blue\n5,Red\n",
        );

        let mask = run_build(&path, "red", b',', 5);
        assert_eq!(mask, vec![0, 2, 4]);

        let _ = fs::remove_file(path);
    }
}
