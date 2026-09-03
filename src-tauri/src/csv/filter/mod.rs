use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use super::CsvError;

pub mod query;
mod scan;

use query::parse_query;
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
    pub headers: Vec<String>,
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
        headers,
        query,
        total_rows,
        generation,
        generation_state,
        state,
    } = options;

    let compiled = parse_query(&query, &headers).map_err(CsvError::InvalidQuery)?;
    if compiled.is_empty() {
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
        &compiled,
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

    fn headers_of(contents: &str) -> Vec<String> {
        contents
            .lines()
            .next()
            .unwrap_or("")
            .split(',')
            .map(|s| s.to_string())
            .collect()
    }

    fn run_build(path: &Path, headers: Vec<String>, query: &str, total_rows: u64) -> Result<Vec<u64>, CsvError> {
        let state = Arc::new(Mutex::new(FilterState::idle()));
        let generation_state = Arc::new(AtomicU64::new(1));

        build_filter(FilterBuildOptions {
            source_path: path.to_path_buf(),
            data_start: 0,
            delimiter: b',',
            headers,
            query: query.to_owned(),
            total_rows,
            generation: 1,
            generation_state,
            state: Arc::clone(&state),
        })?;

        let mask = state.lock().mask.clone().unwrap_or_default();
        Ok(mask)
    }

    #[test]
    fn matches_substring_case_insensitively_across_columns() {
        let contents = "name,city\nAlice,Cape Town\nBob,Durban\nCharlie,CAPE TOWN\nDelta,Pretoria\n";
        let path = write_fixture("clear_rows_filter_basic.csv", contents);

        // "cape" should hit rows 0 and 2 only.
        let mask = run_build(&path, headers_of(contents), "cape", 4).unwrap();
        assert_eq!(mask, vec![0, 2]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn column_scoped_and_negated_terms() {
        let contents = "name,city\nAlice,Cape Town\nBob,Durban\nCharlie,CAPE TOWN\nDelta,Pretoria\n";
        let path = write_fixture("clear_rows_filter_scoped.csv", contents);

        assert_eq!(run_build(&path, headers_of(contents), "city:cape", 4).unwrap(), vec![0, 2]);
        assert_eq!(run_build(&path, headers_of(contents), "name:cape", 4).unwrap(), Vec::<u64>::new());
        assert_eq!(run_build(&path, headers_of(contents), "-city:cape", 4).unwrap(), vec![1, 3]);
        assert_eq!(run_build(&path, headers_of(contents), "city=durban", 4).unwrap(), vec![1]);
        assert_eq!(run_build(&path, headers_of(contents), "name:/^[a-c]/", 4).unwrap(), vec![0, 1, 2]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn unknown_column_is_an_error() {
        let contents = "name,city\nAlice,Cape Town\n";
        let path = write_fixture("clear_rows_filter_badcol.csv", contents);

        let err = run_build(&path, headers_of(contents), "nope:x", 1).unwrap_err();
        assert!(matches!(err, CsvError::InvalidQuery(_)));
        assert!(err.to_string().contains("Unknown column"), "{err}");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn empty_query_clears_filter() {
        let path = write_fixture("clear_rows_filter_empty.csv", "name\nA\nB\nC\n");

        let state = Arc::new(Mutex::new(FilterState::idle()));
        let generation_state = Arc::new(AtomicU64::new(1));
        // Pre-populate mask so we can assert clear() ran.
        state.lock().mask = Some(vec![0]);

        build_filter(FilterBuildOptions {
            source_path: path.to_path_buf(),
            data_start: 0,
            delimiter: b',',
            headers: vec!["name".to_owned()],
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
        let contents = "name\nAlice\nBob\nCharlie\n";
        let path = write_fixture("clear_rows_filter_nomatch.csv", contents);

        let mask = run_build(&path, headers_of(contents), "zzz", 3).unwrap();
        assert!(mask.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn mask_is_returned_in_ascending_physical_order() {
        let contents = "id,tag\n1,red\n2,green\n3,RED\n4,blue\n5,Red\n";
        let path = write_fixture("clear_rows_filter_order.csv", contents);

        let mask = run_build(&path, headers_of(contents), "red", 5).unwrap();
        assert_eq!(mask, vec![0, 2, 4]);

        let _ = fs::remove_file(path);
    }
}
