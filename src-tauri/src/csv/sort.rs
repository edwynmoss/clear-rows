use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::parser::CsvUtf8Parser;
use super::CsvError;

/// Number of (key, phys) pairs held in memory before we spill a sorted chunk
/// to disk. 250k entries ≈ 25-30 MiB of keys for typical short text columns
/// and tracks the empirical sweet spot where chunk-sort time is dwarfed by
/// row-scan time but heap merge stays cheap.
const KEYS_PER_CHUNK: usize = 250_000;

/// Rows sampled (cheaply) at the start of a sort to decide whether the column
/// behaves as numeric or text. Anything beyond a couple thousand rows changes
/// the verdict only at the margins and adds noticeable latency to short sorts.
const SAMPLE_ROWS_FOR_MODE: usize = 2_000;

/// Fraction of non-empty samples that must parse as f64 for us to treat the
/// column as numeric. Below this we fall back to text ordering so a single
/// stray "n/a" row in a numeric column still sorts numerically, while a
/// mostly-text column with a few embedded numbers stays in lex order.
const NUMERIC_RATIO_THRESHOLD: f64 = 0.8;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SortMode {
    Numeric,
    Text,
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

fn open_parser(
    source_path: &Path,
    data_start: u64,
    delimiter: u8,
) -> Result<CsvUtf8Parser<File>, CsvError> {
    let mut file = File::open(source_path)?;
    file.seek(SeekFrom::Start(data_start))?;
    let parser = CsvUtf8Parser::new(file, delimiter)?;
    Ok(parser)
}

fn detect_mode(
    source_path: &Path,
    data_start: u64,
    delimiter: u8,
    column: usize,
) -> Result<SortMode, CsvError> {
    let mut parser = open_parser(source_path, data_start, delimiter)?;
    parser.try_skip_row()?; // header

    let mut sampled = 0;
    let mut numeric = 0;
    let mut non_empty = 0;

    while sampled < SAMPLE_ROWS_FOR_MODE {
        let row = match parser.try_read_row()? {
            Some(row) => row,
            None => break,
        };

        let value = row
            .get(column)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        if let Some(value) = value {
            non_empty += 1;
            if parse_number(value).is_some() {
                numeric += 1;
            }
        }
        sampled += 1;
    }

    if non_empty == 0 {
        return Ok(SortMode::Text);
    }

    if (numeric as f64) / (non_empty as f64) >= NUMERIC_RATIO_THRESHOLD {
        Ok(SortMode::Numeric)
    } else {
        Ok(SortMode::Text)
    }
}

fn parse_number(s: &str) -> Option<f64> {
    let v: f64 = s.parse().ok()?;
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

/// Convert an f64 to a u64 whose unsigned big-endian byte order matches the
/// original numeric ordering (including sign). Negatives invert all bits;
/// non-negatives flip only the sign bit so 0 lands at the midpoint.
fn f64_to_sortable_u64(v: f64) -> u64 {
    let bits = v.to_bits();
    if (bits >> 63) & 1 == 1 {
        !bits
    } else {
        bits ^ (1u64 << 63)
    }
}

/// Build the byte representation that drives the sort. Layout choices:
/// - leading 0xFF tag pushes empty/null cells to the end of the order
/// - leading 0x00 tag for "primary" values (numbers in numeric mode, text in
///   text mode) so they group ahead of fallback cells
/// - leading 0x80 tag for non-numeric strings stuck inside a numeric column;
///   they fall between real numbers and empty cells, matching what users
///   intuitively expect from a "mostly numeric" column with stray labels.
fn encode_key(raw: &str, mode: SortMode) -> Vec<u8> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![0xFF];
    }

    match mode {
        SortMode::Numeric => match parse_number(trimmed) {
            Some(n) => {
                let bits = f64_to_sortable_u64(n).to_be_bytes();
                let mut out = Vec::with_capacity(9);
                out.push(0x00);
                out.extend_from_slice(&bits);
                out
            }
            None => {
                let lower = trimmed.to_ascii_lowercase();
                let mut out = Vec::with_capacity(1 + lower.len());
                out.push(0x80);
                out.extend_from_slice(lower.as_bytes());
                out
            }
        },
        SortMode::Text => {
            let lower = trimmed.to_ascii_lowercase();
            let mut out = Vec::with_capacity(1 + lower.len());
            out.push(0x00);
            out.extend_from_slice(lower.as_bytes());
            out
        }
    }
}

#[derive(Clone)]
struct EncodedKey {
    key: Vec<u8>,
    phys: u64,
}

impl EncodedKey {
    fn cmp(a: &EncodedKey, b: &EncodedKey) -> Ordering {
        a.key.cmp(&b.key).then_with(|| a.phys.cmp(&b.phys))
    }
}

fn write_chunk(path: &Path, keys: &[EncodedKey]) -> Result<(), CsvError> {
    let f = File::create(path)?;
    let mut w = BufWriter::with_capacity(64 * 1024, f);
    for k in keys {
        let len = u32::try_from(k.key.len()).unwrap_or(u32::MAX);
        w.write_all(&len.to_le_bytes())?;
        w.write_all(&k.key)?;
        w.write_all(&k.phys.to_le_bytes())?;
    }
    w.flush()?;
    Ok(())
}

struct ChunkReader {
    reader: BufReader<File>,
    head: Option<EncodedKey>,
}

impl ChunkReader {
    fn open(path: &Path) -> Result<Self, CsvError> {
        let file = File::open(path)?;
        let reader = BufReader::with_capacity(64 * 1024, file);
        let mut me = Self { reader, head: None };
        me.advance()?;
        Ok(me)
    }

    fn advance(&mut self) -> Result<(), CsvError> {
        let mut len_buf = [0u8; 4];
        match self.reader.read_exact(&mut len_buf) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                self.head = None;
                return Ok(());
            }
            Err(e) => return Err(CsvError::Io(e)),
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        let mut key = vec![0u8; len];
        self.reader.read_exact(&mut key)?;
        let mut phys_buf = [0u8; 8];
        self.reader.read_exact(&mut phys_buf)?;
        self.head = Some(EncodedKey {
            key,
            phys: u64::from_le_bytes(phys_buf),
        });
        Ok(())
    }
}

struct HeapEntry {
    key: EncodedKey,
    source: usize,
}

impl Eq for HeapEntry {}

impl PartialEq for HeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap: invert the natural order so the smallest key pops first.
        // Tie-break on source index to preserve the chunk-sort's stable order.
        EncodedKey::cmp(&other.key, &self.key).then_with(|| other.source.cmp(&self.source))
    }
}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn merge_chunks(paths: &[PathBuf], total_rows: u64) -> Result<Vec<u64>, CsvError> {
    let mut readers: Vec<ChunkReader> = paths
        .iter()
        .map(|p| ChunkReader::open(p))
        .collect::<Result<_, _>>()?;
    let mut heap: BinaryHeap<HeapEntry> = BinaryHeap::with_capacity(readers.len());

    for (i, reader) in readers.iter_mut().enumerate() {
        if let Some(head) = reader.head.take() {
            heap.push(HeapEntry { key: head, source: i });
        }
    }

    let capacity = usize::try_from(total_rows).unwrap_or(0);
    let mut perm = Vec::with_capacity(capacity);

    while let Some(entry) = heap.pop() {
        perm.push(entry.key.phys);
        let reader = &mut readers[entry.source];
        reader.advance()?;
        if let Some(head) = reader.head.take() {
            heap.push(HeapEntry {
                key: head,
                source: entry.source,
            });
        }
    }

    Ok(perm)
}

fn cleanup_spills(paths: &[PathBuf], dir: &Path) {
    for p in paths {
        let _ = fs::remove_file(p);
    }
    let _ = fs::remove_dir_all(dir);
}

fn is_active(generation_state: &Arc<AtomicU64>, generation: u64) -> bool {
    generation_state.load(AtomicOrdering::SeqCst) == generation
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

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
