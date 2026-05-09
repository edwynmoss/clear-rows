use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::CsvError;

mod key;
mod mode;
mod spill;

use key::{encode_key, EncodedKey};
use mode::{detect_mode, open_parser};
use spill::{cleanup_spills, merge_chunks, write_chunk};

/// Number of (key, phys) pairs held in memory before we spill a sorted chunk
/// to disk. 250k entries ≈ 25-30 MiB of keys for typical short text columns
/// and tracks the empirical sweet spot where chunk-sort time is dwarfed by
/// row-scan time but heap merge stays cheap.
const KEYS_PER_CHUNK: usize = 250_000;

/// How often (in rows) we publish progress to the shared status. Tighter
/// updates pay no IPC cost (status is read on demand) but we still want to
/// avoid lock thrash on hot scan loops.
const PROGRESS_UPDATE_INTERVAL: u64 = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Default, Serialize)]
pub struct SortStatus {
    pub is_sorting: bool,
    pub is_ready: bool,
    pub column: Option<usize>,
    pub direction: Option<SortDirection>,
    pub rows_scanned: u64,
    pub total_rows: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct SortState {
    pub status: SortStatus,
    /// `permutation[sorted_index] == physical_data_index` (0-based, header
    /// excluded). `None` when no sort is active.
    pub permutation: Option<Vec<u64>>,
}

impl SortState {
    pub fn idle() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.status = SortStatus::default();
        self.permutation = None;
    }
}

pub struct SortBuildOptions {
    pub source_path: PathBuf,
    pub data_start: u64,
    pub delimiter: u8,
    pub column: usize,
    pub direction: SortDirection,
    pub spill_dir: PathBuf,
    pub generation: u64,
    pub generation_state: Arc<AtomicU64>,
    pub state: Arc<Mutex<SortState>>,
}

pub fn build_sort(options: SortBuildOptions) -> Result<(), CsvError> {
    let SortBuildOptions {
        source_path,
        data_start,
        delimiter,
        column,
        direction,
        spill_dir,
        generation,
        generation_state,
        state,
    } = options;

    // Fresh spill directory per build. Best-effort cleanup on any prior run.
    let _ = fs::remove_dir_all(&spill_dir);
    fs::create_dir_all(&spill_dir)?;

    let mode = detect_mode(&source_path, data_start, delimiter, column)?;
    if !is_active(&generation_state, generation) {
        let _ = fs::remove_dir_all(&spill_dir);
        return Ok(());
    }

    let mut parser = open_parser(&source_path, data_start, delimiter)?;
    parser.try_skip_row()?; // header

    let mut buffer: Vec<EncodedKey> = Vec::with_capacity(KEYS_PER_CHUNK.min(64_000));
    let mut chunk_paths: Vec<PathBuf> = Vec::new();
    let mut total_scanned: u64 = 0;
    let mut phys_idx: u64 = 0;

    loop {
        if !is_active(&generation_state, generation) {
            cleanup_spills(&chunk_paths, &spill_dir);
            return Ok(());
        }

        let row = match parser.try_read_row()? {
            Some(row) => row,
            None => break,
        };

        let raw = row.get(column).map(String::as_str).unwrap_or("");
        let key = encode_key(raw, mode);
        buffer.push(EncodedKey {
            key,
            phys: phys_idx,
        });

        phys_idx += 1;
        total_scanned += 1;

        if total_scanned % PROGRESS_UPDATE_INTERVAL == 0 {
            state.lock().status.rows_scanned = total_scanned;
        }

        if buffer.len() >= KEYS_PER_CHUNK {
            buffer.sort_unstable_by(EncodedKey::cmp);
            let path = spill_dir.join(format!("chunk-{:05}.bin", chunk_paths.len()));
            write_chunk(&path, &buffer)?;
            chunk_paths.push(path);
            buffer.clear();
        }
    }

    if !is_active(&generation_state, generation) {
        cleanup_spills(&chunk_paths, &spill_dir);
        return Ok(());
    }

    state.lock().status.rows_scanned = total_scanned;

    let permutation = if chunk_paths.is_empty() {
        buffer.sort_unstable_by(EncodedKey::cmp);
        buffer.into_iter().map(|k| k.phys).collect::<Vec<u64>>()
    } else {
        if !buffer.is_empty() {
            buffer.sort_unstable_by(EncodedKey::cmp);
            let path = spill_dir.join(format!("chunk-{:05}.bin", chunk_paths.len()));
            write_chunk(&path, &buffer)?;
            chunk_paths.push(path);
            buffer.clear();
        }
        let merged = merge_chunks(&chunk_paths, total_scanned)?;
        cleanup_spills(&chunk_paths, &spill_dir);
        merged
    };

    let mut final_perm = permutation;
    if direction == SortDirection::Desc {
        final_perm.reverse();
    }

    let _ = fs::remove_dir_all(&spill_dir);

    if !is_active(&generation_state, generation) {
        return Ok(());
    }

    let mut s = state.lock();
    s.permutation = Some(final_perm);
    s.status.is_sorting = false;
    s.status.is_ready = true;
    s.status.column = Some(column);
    s.status.direction = Some(direction);
    s.status.rows_scanned = total_scanned;
    s.status.total_rows = total_scanned;
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

    fn run_build(
        path: &Path,
        column: usize,
        direction: SortDirection,
        delimiter: u8,
    ) -> Vec<u64> {
        let state = Arc::new(Mutex::new(SortState::idle()));
        let generation_state = Arc::new(AtomicU64::new(1));
        let spill_dir = std::env::temp_dir().join(format!(
            "clear-rows-sort-test-{}-{}",
            std::process::id(),
            generation_state.load(AtomicOrdering::SeqCst)
        ));

        build_sort(SortBuildOptions {
            source_path: path.to_path_buf(),
            data_start: 0,
            delimiter,
            column,
            direction,
            spill_dir,
            generation: 1,
            generation_state,
            state: Arc::clone(&state),
        })
        .expect("build sort");

        let perm = state.lock().permutation.clone().expect("permutation");
        perm
    }

    #[test]
    fn sorts_text_column_ascending() {
        let path = write_fixture(
            "clear_rows_sort_text_asc.csv",
            "name,city\nCharlie,Cape Town\nalpha,Durban\nBravo,Pretoria\n",
        );

        let perm = run_build(&path, 0, SortDirection::Asc, b',');
        // alpha, Bravo, Charlie (case-insensitive)
        assert_eq!(perm, vec![1, 2, 0]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn sorts_numeric_column_descending() {
        let path = write_fixture(
            "clear_rows_sort_num_desc.csv",
            "id,score\n1,10\n2,200\n3,30\n4,4000\n",
        );

        let perm = run_build(&path, 1, SortDirection::Desc, b',');
        // scores descending: 4000, 200, 30, 10 → original phys 3, 1, 2, 0
        assert_eq!(perm, vec![3, 1, 2, 0]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn empty_cells_sort_last() {
        let path = write_fixture(
            "clear_rows_sort_empty_last.csv",
            "id,name\n1,Charlie\n2,\n3,alpha\n",
        );

        let perm = run_build(&path, 1, SortDirection::Asc, b',');
        // alpha, Charlie, (empty) → 2, 0, 1
        assert_eq!(perm, vec![2, 0, 1]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn numeric_sort_handles_negative_and_decimals() {
        let path = write_fixture(
            "clear_rows_sort_num_signed.csv",
            "id,value\n1,-2.5\n2,1.5\n3,-10\n4,0\n5,1.5\n",
        );

        let perm = run_build(&path, 1, SortDirection::Asc, b',');
        // values: -10, -2.5, 0, 1.5, 1.5 → phys 2, 0, 3, 1, 4 (stable)
        assert_eq!(perm, vec![2, 0, 3, 1, 4]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn external_spill_path_produces_same_order_as_in_memory() {
        // Generate enough rows to trigger spilling. Use a synthetic numeric
        // column so the comparator is unambiguous.
        let mut contents = String::from("idx,value\n");
        let n: u64 = (KEYS_PER_CHUNK as u64) * 3 / 2; // forces ≥ 2 chunks
        // Reverse insertion so sorted order differs from physical order.
        for i in (0..n).rev() {
            contents.push_str(&format!("{},{}\n", i, i));
        }
        let path = write_fixture("clear_rows_sort_external.csv", &contents);

        let perm = run_build(&path, 1, SortDirection::Asc, b',');
        assert_eq!(perm.len() as u64, n);
        // Sorted ascending by value (== inserted index from n-1 down to 0)
        // means the sorted permutation should map sorted[i] -> phys row that
        // originally held value i. Since we wrote values from n-1 down to 0,
        // value i is at physical index (n - 1 - i). So perm[i] == n-1-i.
        for i in 0..n {
            assert_eq!(perm[i as usize], n - 1 - i);
        }

        let _ = fs::remove_file(path);
    }
}
