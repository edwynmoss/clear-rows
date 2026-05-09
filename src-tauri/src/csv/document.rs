use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use encoding_rs::{UTF_16BE, UTF_16LE};
use encoding_rs_io::DecodeReaderBytesBuilder;
use serde::Serialize;
use thiserror::Error;

use super::profile::{delimiter_label, Encoding, ProfiledCsvFile};
use super::{profile_csv_path, CsvFileProfile, CsvUtf8Parser};

#[derive(Default)]
pub struct OpenOptions {
    pub delimiter_override: Option<u8>,
    pub encoding_override: Option<String>,
}

/// Physical rows between byte-offset checkpoints for random access.
const DEFAULT_BLOCK_SIZE: u64 = 1024;
/// Safety bound for IPC payload size (rows × columns × field length).
const MAX_ROWS_PER_BATCH: usize = 256;
/// Prevent multi-megabyte JSON cells from blowing up WebView IPC / RAM.
const MAX_CELL_PREVIEW_BYTES: usize = 12_288;

#[derive(Debug, Error)]
pub enum CsvError {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("Row missing while seeking")]
    MissingRow,

    #[error("No document is open")]
    NoDocument,

    #[error("Too many rows requested in one batch")]
    BatchTooLarge,

    #[error("Unsupported file: {0}")]
    UnsupportedFile(String),
}

#[derive(Clone, Serialize)]
pub struct OpenSummary {
    pub path: String,
    pub delimiter: u8,
    pub headers: Vec<String>,
    pub row_count: u64,
    pub is_complete: bool,
    pub indexed_bytes: u64,
    pub file_size: u64,
    pub error: Option<String>,
    pub profile: CsvFileProfile,
}

#[derive(Clone, Serialize)]
pub struct IndexStatus {
    pub path: String,
    pub row_count: u64,
    pub is_complete: bool,
    pub indexed_bytes: u64,
    pub file_size: u64,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RowBatch {
    pub start: u64,
    pub column_start: usize,
    pub rows: Vec<Vec<String>>,
}

pub struct CsvDocument {
    path: PathBuf,
    /// Path the parser/indexer/sort actually reads from. For UTF-8 sources this
    /// equals `path`; for UTF-16 sources it points at the transcoded UTF-8
    /// cache file held alive by `cache_guard`.
    read_path: PathBuf,
    /// Byte offset within `read_path` where the CSV data (header row) starts.
    read_data_start: u64,
    delimiter: u8,
    profile: CsvFileProfile,
    block_starts: Vec<u64>,
    block_size: u64,
    headers: Vec<String>,
    physical_rows: u64,
    indexed_bytes: u64,
    file_size: u64,
    is_complete: bool,
    index_error: Option<String>,
    parser: CsvUtf8Parser<File>,
    indexer: Option<CsvUtf8Parser<File>>,
    // Must be the last field: declaration order is drop order, so the cache
    // file is removed only after `parser` and `indexer` have released their
    // File handles (Windows refuses removal while handles are open).
    // Held for its Drop side-effect; not read in release builds.
    #[allow(dead_code)]
    cache_guard: Option<CacheGuard>,
}

struct CacheGuard {
    path: PathBuf,
}

impl Drop for CacheGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl CsvDocument {
    #[cfg(test)]
    pub fn open(path: impl AsRef<Path>) -> Result<Self, CsvError> {
        let mut document = Self::open_progressive(path, 0)?;
        document.index_to_completion()?;
        Ok(document)
    }

    #[cfg(test)]
    pub fn open_progressive(
        path: impl AsRef<Path>,
        initial_data_rows: usize,
    ) -> Result<Self, CsvError> {
        Self::open_progressive_with_options(path, initial_data_rows, OpenOptions::default())
    }

    pub fn open_progressive_with_options(
        path: impl AsRef<Path>,
        initial_data_rows: usize,
        options: OpenOptions,
    ) -> Result<Self, CsvError> {
        let path = path.as_ref().to_path_buf();
        let mut profiled = profile_csv_path(&path)?;

        // User overrides win over auto-detection. Applied after profiling so we
        // still benefit from the profile's binary-like / sample-based checks.
        if let Some(delimiter) = options.delimiter_override {
            apply_delimiter_override(&mut profiled, delimiter);
        }
        if let Some(encoding_override) = options.encoding_override.as_deref() {
            apply_encoding_override(&mut profiled, encoding_override, &path)?;
        }

        if profiled.profile.binary_like {
            return Err(CsvError::UnsupportedFile(
                "File appears to be binary or uses an unsupported encoding".to_owned(),
            ));
        }

        let (read_path, read_data_start, cache_guard) = match profiled.encoding {
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let cache = transcode_to_utf8_cache(&path, profiled.encoding)?;
                let guard = CacheGuard {
                    path: cache.clone(),
                };
                (cache, 0u64, Some(guard))
            }
            Encoding::Utf8 | Encoding::Utf8Bom => (path.clone(), profiled.data_start, None),
        };

        // file_size is the indexer's denominator; for UTF-16 the indexer streams
        // the transcoded cache, so measure it (not the source) to keep progress
        // (indexed_bytes / file_size) meaningful in both cases.
        let file_size = read_path.metadata()?.len();

        let mut index_file = File::open(&read_path)?;
        index_file.seek(SeekFrom::Start(read_data_start))?;
        let delimiter = profiled.delimiter;
        let mut indexer = CsvUtf8Parser::new(index_file, delimiter)?;

        let mut block_starts: Vec<u64> = Vec::new();
        let mut row_index: u64 = 0;
        let mut headers: Vec<String> = Vec::new();
        let mut is_complete = false;
        let indexed_bytes;

        block_starts.push(indexer.next_byte_offset());
        match indexer.try_read_row()? {
            Some(fields) => {
                headers = fields;
                row_index += 1;
                indexed_bytes = indexer.next_byte_offset();
            }
            None => {
                is_complete = true;
                indexed_bytes = file_size;
            }
        }

        let mut access_file = File::open(&read_path)?;
        access_file.seek(SeekFrom::Start(read_data_start))?;
        let parser = CsvUtf8Parser::new(access_file, delimiter)?;

        let mut document = Self {
            path,
            read_path,
            read_data_start,
            delimiter,
            profile: profiled.profile,
            block_starts,
            block_size: DEFAULT_BLOCK_SIZE,
            headers,
            physical_rows: row_index,
            indexed_bytes,
            file_size,
            is_complete,
            index_error: None,
            parser,
            indexer: if is_complete { None } else { Some(indexer) },
            cache_guard,
        };

        document.index_next_chunk(initial_data_rows)?;
        Ok(document)
    }

    pub fn summarize(&self) -> OpenSummary {
        OpenSummary {
            path: self.path.to_string_lossy().into_owned(),
            delimiter: self.delimiter,
            headers: self.headers.clone(),
            row_count: self.data_row_count(),
            is_complete: self.is_complete,
            indexed_bytes: self.indexed_bytes,
            file_size: self.file_size,
            error: self.index_error.clone(),
            profile: self.profile.clone(),
        }
    }

    pub fn index_status(&self) -> IndexStatus {
        IndexStatus {
            path: self.path.to_string_lossy().into_owned(),
            row_count: self.data_row_count(),
            is_complete: self.is_complete,
            indexed_bytes: self.indexed_bytes,
            file_size: self.file_size,
            error: self.index_error.clone(),
        }
    }

    pub fn data_row_count(&self) -> u64 {
        self.physical_rows.saturating_sub(1)
    }

    pub fn delimiter(&self) -> u8 {
        self.delimiter
    }

    pub fn read_path(&self) -> &Path {
        &self.read_path
    }

    pub fn read_data_start(&self) -> u64 {
        self.read_data_start
    }

    pub fn is_indexing_complete(&self) -> bool {
        self.is_complete
    }

    pub fn mark_index_error(&mut self, error: String) {
        self.index_error = Some(error);
        self.is_complete = true;
        self.indexer = None;
    }

    #[cfg(test)]
    pub fn index_to_completion(&mut self) -> Result<(), CsvError> {
        while !self.index_next_chunk(DEFAULT_BLOCK_SIZE as usize)? {}
        Ok(())
    }

    pub fn index_next_chunk(&mut self, max_data_rows: usize) -> Result<bool, CsvError> {
        if self.is_complete || max_data_rows == 0 {
            return Ok(self.is_complete);
        }

        let Some(indexer) = self.indexer.as_mut() else {
            self.is_complete = true;
            self.indexed_bytes = self.file_size;
            return Ok(true);
        };

        let mut reached_end = false;

        for _ in 0..max_data_rows {
            if self.physical_rows % self.block_size == 0 {
                self.block_starts.push(indexer.next_byte_offset());
            }

            match indexer.try_skip_row()? {
                Some(()) => {
                    self.physical_rows += 1;
                    self.indexed_bytes = indexer.next_byte_offset().min(self.file_size);
                }
                None => {
                    reached_end = true;
                    break;
                }
            }
        }

        if reached_end {
            self.is_complete = true;
            self.indexed_bytes = self.file_size;
            self.indexer = None;
            return Ok(true);
        }

        Ok(false)
    }

    pub fn get_rows(
        &mut self,
        start: u64,
        count: usize,
        column_start: usize,
        column_count: usize,
    ) -> Result<RowBatch, CsvError> {
        if count > MAX_ROWS_PER_BATCH {
            return Err(CsvError::BatchTooLarge);
        }

        let header_len = self.headers.len();
        let safe_column_start = column_start.min(header_len);
        let visible_column_count = column_count.min(header_len.saturating_sub(safe_column_start));

        if count == 0 {
            return Ok(RowBatch {
                start,
                column_start: safe_column_start,
                rows: Vec::new(),
            });
        }

        let max_data = self.data_row_count();
        if start >= max_data {
            return Ok(RowBatch {
                start,
                column_start: safe_column_start,
                rows: Vec::new(),
            });
        }

        let available = (max_data - start) as usize;
        let take = count.min(available);

        // One seek + sequential reads — avoids O(batch × skip) re-parsing per row.
        let physical_first = start.saturating_add(1);
        self.seek_before_physical_row(physical_first)?;

        let mut rows = Vec::with_capacity(take);

        for _ in 0..take {
            let row = match self.parser.try_read_row()? {
                Some(r) => r,
                None => return Err(CsvError::MissingRow),
            };

            rows.push(preview_sliced_row(
                row,
                safe_column_start,
                visible_column_count,
            ));
        }

        Ok(RowBatch {
            start,
            column_start: safe_column_start,
            rows,
        })
    }

    /// Read rows by physical data-row index (0-based, header excluded). Used
    /// by sorted/filtered fetches where consecutive sorted indices may map to
    /// arbitrary positions in the underlying file.
    pub fn get_rows_at_physical_data_indices(
        &mut self,
        sorted_start: u64,
        physical_indices: &[u64],
        column_start: usize,
        column_count: usize,
    ) -> Result<RowBatch, CsvError> {
        if physical_indices.len() > MAX_ROWS_PER_BATCH {
            return Err(CsvError::BatchTooLarge);
        }

        let header_len = self.headers.len();
        let safe_column_start = column_start.min(header_len);
        let visible_column_count = column_count.min(header_len.saturating_sub(safe_column_start));

        if physical_indices.is_empty() {
            return Ok(RowBatch {
                start: sorted_start,
                column_start: safe_column_start,
                rows: Vec::new(),
            });
        }

        let max_data = self.data_row_count();
        let mut rows = Vec::with_capacity(physical_indices.len());

        for &phys in physical_indices {
            if phys >= max_data {
                // Index points past what's currently indexed. Emit a blank
                // placeholder rather than failing the whole batch — the
                // virtualizer asks for windows that may straddle the indexed
                // edge during progressive opens.
                rows.push(blank_row(visible_column_count));
                continue;
            }

            let physical_row = phys.saturating_add(1);
            self.seek_before_physical_row(physical_row)?;

            let row = match self.parser.try_read_row()? {
                Some(r) => r,
                None => return Err(CsvError::MissingRow),
            };

            rows.push(preview_sliced_row(
                row,
                safe_column_start,
                visible_column_count,
            ));
        }

        Ok(RowBatch {
            start: sorted_start,
            column_start: safe_column_start,
            rows,
        })
    }

    #[cfg(test)]
    fn cache_path(&self) -> Option<PathBuf> {
        self.cache_guard.as_ref().map(|g| g.path.clone())
    }

    fn seek_before_physical_row(&mut self, physical_row: u64) -> Result<(), CsvError> {
        let block = (physical_row / self.block_size) as usize;
        let seek = *self.block_starts.get(block).ok_or(CsvError::MissingRow)?;

        let skip = physical_row - (physical_row / self.block_size) * self.block_size;

        self.parser.seek(seek)?;

        for _ in 0..skip {
            match self.parser.try_skip_row()? {
                Some(()) => {}
                None => return Err(CsvError::MissingRow),
            }
        }

        Ok(())
    }
}

fn blank_row(column_count: usize) -> Vec<String> {
    (0..column_count).map(|_| String::new()).collect()
}

fn preview_sliced_row(row: Vec<String>, column_start: usize, column_count: usize) -> Vec<String> {
    let mut preview = Vec::with_capacity(column_count);

    for column_index in column_start..column_start.saturating_add(column_count) {
        let cell = row.get(column_index).cloned().unwrap_or_default();
        preview.push(truncate_cell_preview(cell));
    }

    preview
}

/// Transcode a UTF-16 source file to a UTF-8 cache file and return the cache
/// path. The cache file is uniquely named per call and is owned by the caller
/// (deleted by `CacheGuard` when the document drops); cross-session reuse is
/// intentionally not attempted, so users don't accumulate hundreds of MB of
/// transcoded text in temp.
///
/// On entry, stale entries (older than 24h, e.g. from a prior app crash) are
/// swept as a belt-and-suspenders cleanup.
///
/// The output is plain UTF-8 with no BOM; downstream callers should pass
/// `data_start = 0` for the cache path.
fn transcode_to_utf8_cache(source: &Path, encoding: Encoding) -> std::io::Result<PathBuf> {
    let cache_dir = std::env::temp_dir().join("clear-rows").join("utf8-cache");
    std::fs::create_dir_all(&cache_dir)?;

    sweep_stale_cache_entries(&cache_dir, Duration::from_secs(24 * 60 * 60));

    // Unique-per-call: pid + nanos + source-path hash. Avoids cross-document
    // races on the same source and removes any need for a `.partial` rename
    // since no other call competes for this name.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    let source_hash = hasher.finish();
    let cache_path = cache_dir.join(format!(
        "{}-{:032x}-{:016x}.utf8",
        std::process::id(),
        nanos,
        source_hash
    ));

    let charset = match encoding {
        Encoding::Utf16Le => UTF_16LE,
        Encoding::Utf16Be => UTF_16BE,
        _ => unreachable!("transcode_to_utf8_cache called with non-UTF-16 encoding"),
    };

    let source_file = File::open(source)?;
    let mut decoded = DecodeReaderBytesBuilder::new()
        .encoding(Some(charset))
        .bom_sniffing(true)
        .build(source_file);
    // 256 KiB BufWriter cuts io::copy's syscall count ~32x vs the default
    // 8 KiB internal buffer; meaningful on large UTF-16 first-opens.
    let cache_file = File::create(&cache_path)?;
    let mut writer = BufWriter::with_capacity(256 * 1024, cache_file);
    std::io::copy(&mut decoded, &mut writer)?;
    writer.flush()?;
    let cache_file = writer.into_inner().map_err(|e| e.into_error())?;
    cache_file.sync_all()?;
    drop(cache_file);

    Ok(cache_path)
}

fn sweep_stale_cache_entries(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .map(|age| age > max_age)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn apply_delimiter_override(profiled: &mut ProfiledCsvFile, delimiter: u8) {
    profiled.delimiter = delimiter;
    profiled.profile.delimiter = Some(delimiter);
    profiled.profile.delimiter_label = Some(delimiter_label(delimiter).to_owned());
    profiled.profile.delimiter_confidence = "user".to_owned();
    // Drop warnings that auto-detection emitted about delimiter quality; the
    // user has now made an explicit choice and re-surfacing those would be noise.
    profiled.profile.warnings.retain(|warning| {
        !warning.contains("delimiter")
            && !warning.contains("Delimiter")
            && !warning.contains("consistent delimiter")
    });
}

fn apply_encoding_override(
    profiled: &mut ProfiledCsvFile,
    choice: &str,
    path: &Path,
) -> std::io::Result<()> {
    let normalized = choice.to_ascii_lowercase();
    let (encoding, label) = match normalized.as_str() {
        "utf-8" => (Encoding::Utf8, "utf-8"),
        "utf-8-bom" => (Encoding::Utf8Bom, "utf-8-bom"),
        "utf-16-le" => (Encoding::Utf16Le, "utf-16-le"),
        "utf-16-be" => (Encoding::Utf16Be, "utf-16-be"),
        // Unknown choice: leave detection in place rather than corrupting state.
        _ => return Ok(()),
    };

    let data_start = data_start_for_override(path, encoding)?;
    profiled.encoding = encoding;
    profiled.data_start = data_start;
    profiled.profile.encoding = label.to_owned();
    // User asserted the encoding; trust them over the binary-looking heuristic
    // (e.g. BOM-less UTF-16 reads as binary to the byte-level sniffer).
    profiled.profile.binary_like = false;
    profiled.profile.warnings.retain(|warning| {
        !warning.contains("UTF-8") && !warning.contains("Binary-looking")
    });

    Ok(())
}

fn data_start_for_override(path: &Path, encoding: Encoding) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    let mut prefix = [0u8; 3];
    let n = file.read(&mut prefix)?;

    let matches_bom = match encoding {
        Encoding::Utf8 => false,
        Encoding::Utf8Bom => n >= 3 && prefix == [0xEF, 0xBB, 0xBF],
        Encoding::Utf16Le => n >= 2 && prefix[0] == 0xFF && prefix[1] == 0xFE,
        Encoding::Utf16Be => n >= 2 && prefix[0] == 0xFE && prefix[1] == 0xFF,
    };

    Ok(match encoding {
        Encoding::Utf8 => 0,
        Encoding::Utf8Bom => {
            if matches_bom {
                3
            } else {
                0
            }
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            if matches_bom {
                2
            } else {
                0
            }
        }
    })
}

fn truncate_cell_preview(s: String) -> String {
    if s.len() <= MAX_CELL_PREVIEW_BYTES {
        return s;
    }

    let mut idx = MAX_CELL_PREVIEW_BYTES;
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

    fn write_utf16_fixture(path: &Path, text: &str, bom: [u8; 2], little_endian: bool) {
        let mut bytes = bom.to_vec();
        for unit in text.encode_utf16() {
            let pair = if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            };
            bytes.extend_from_slice(&pair);
        }
        fs::write(path, &bytes).expect("write utf-16 fixture");
    }

    #[test]
    fn opens_utf16_le_comma_csv_end_to_end() {
        let path = std::env::temp_dir().join("dataparser_doc_utf16_le.csv");
        write_utf16_fixture(
            &path,
            "id,name,city\n1,Alpha,Cape Town\n2,Beta,Durban\n3,Gamma,Pretoria\n",
            [0xFF, 0xFE],
            true,
        );

        let mut document = CsvDocument::open(&path).expect("open utf-16-le csv");
        let summary = document.summarize();

        assert_eq!(summary.delimiter, b',');
        assert_eq!(summary.headers, ["id", "name", "city"]);
        assert_eq!(summary.row_count, 3);
        assert_eq!(summary.profile.encoding, "utf-16-le");

        let rows = document.get_rows(0, 3, 0, 3).expect("read rows");
        assert_eq!(rows.rows.len(), 3);
        assert_eq!(rows.rows[0], vec!["1", "Alpha", "Cape Town"]);
        assert_eq!(rows.rows[1], vec!["2", "Beta", "Durban"]);
        assert_eq!(rows.rows[2], vec!["3", "Gamma", "Pretoria"]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn utf16_cache_file_is_removed_when_document_drops() {
        let path = std::env::temp_dir().join("dataparser_doc_utf16_cache_drop.csv");
        write_utf16_fixture(
            &path,
            "id,name\n1,Alpha\n2,Beta\n",
            [0xFF, 0xFE],
            true,
        );

        let cache_path = {
            let document = CsvDocument::open(&path).expect("open utf-16 csv");
            let cp = document.cache_path().expect("utf-16 doc owns a cache file");
            assert!(cp.exists(), "cache file present while document is open");
            cp
        };
        assert!(
            !cache_path.exists(),
            "cache file should be removed once the document drops"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn delimiter_override_forces_chosen_delimiter() {
        // Auto-detection would land on comma here. The override must win and
        // also clean up stale "wrong delimiter" warnings.
        let path = std::env::temp_dir().join("dataparser_doc_delim_override.csv");
        fs::write(&path, "id,name|city\n1,Alpha|Cape Town\n2,Beta|Durban\n").expect("fixture");

        let document = CsvDocument::open_progressive_with_options(
            &path,
            8,
            OpenOptions {
                delimiter_override: Some(b'|'),
                encoding_override: None,
            },
        )
        .expect("open with delimiter override");

        let summary = document.summarize();
        assert_eq!(summary.delimiter, b'|');
        assert_eq!(summary.profile.delimiter_label.as_deref(), Some("pipe"));
        assert_eq!(summary.profile.delimiter_confidence, "user");
        // The fixture is comma-separated for the first field by design — splitting
        // it on `|` proves the override actually drives the parser.
        assert_eq!(summary.headers, ["id,name", "city"]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn encoding_override_routes_through_transcode_cache() {
        // Same UTF-16 LE bytes the existing test uses, but with a missing BOM
        // to simulate a file we'd not auto-detect; the user override has to
        // pick up the slack and route through the cache pipeline.
        let path = std::env::temp_dir().join("dataparser_doc_enc_override.csv");
        let mut bytes = Vec::new();
        for unit in "id,name\n1,Alpha\n2,Beta\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&path, &bytes).expect("fixture");

        let mut document = CsvDocument::open_progressive_with_options(
            &path,
            8,
            OpenOptions {
                delimiter_override: None,
                encoding_override: Some("utf-16-le".to_owned()),
            },
        )
        .expect("open with encoding override");

        let summary = document.summarize();
        assert_eq!(summary.profile.encoding, "utf-16-le");
        assert_eq!(summary.headers, ["id", "name"]);

        let rows = document.get_rows(0, 2, 0, 2).expect("read rows");
        assert_eq!(rows.rows[0], vec!["1", "Alpha"]);
        assert_eq!(rows.rows[1], vec!["2", "Beta"]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn utf8_documents_have_no_cache_guard() {
        let path = std::env::temp_dir().join("dataparser_doc_utf8_no_cache.csv");
        fs::write(&path, "id,name\n1,Alpha\n").expect("write fixture");

        let document = CsvDocument::open(&path).expect("open utf-8 csv");
        assert!(document.cache_path().is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn opens_utf16_be_comma_csv_end_to_end() {
        let path = std::env::temp_dir().join("dataparser_doc_utf16_be.csv");
        write_utf16_fixture(
            &path,
            "id,name\n1,Alpha\n2,Beta\n",
            [0xFE, 0xFF],
            false,
        );

        let mut document = CsvDocument::open(&path).expect("open utf-16-be csv");
        let summary = document.summarize();

        assert_eq!(summary.delimiter, b',');
        assert_eq!(summary.headers, ["id", "name"]);
        assert_eq!(summary.row_count, 2);
        assert_eq!(summary.profile.encoding, "utf-16-be");

        let rows = document.get_rows(0, 2, 0, 2).expect("read rows");
        assert_eq!(rows.rows[0], vec!["1", "Alpha"]);
        assert_eq!(rows.rows[1], vec!["2", "Beta"]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn opens_semicolon_csv_with_json_quoted_fields() {
        let path = std::env::temp_dir().join("dataparser_semicolon_json_fixture.csv");
        fs::write(
            &path,
            concat!(
                "architectures;browser_extension;name\n",
                r#""[""x64""]";"{""id"": ""abc"", ""enabled"": false}";Google Docs Offline"#,
                "\n",
            ),
        )
        .expect("write csv fixture");

        let mut document = CsvDocument::open(&path).expect("open csv fixture");
        let summary = document.summarize();

        assert_eq!(summary.delimiter, b';');
        assert_eq!(
            summary.headers,
            ["architectures", "browser_extension", "name"]
        );
        assert_eq!(summary.row_count, 1);

        let rows = document.get_rows(0, 1, 0, 3).expect("read first row");
        assert_eq!(rows.column_start, 0);
        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0][0], r#"["x64"]"#);
        assert_eq!(rows.rows[0][1], r#"{"id": "abc", "enabled": false}"#);
        assert_eq!(rows.rows[0][2], "Google Docs Offline");

        let sliced = document
            .get_rows(0, 1, 1, 1)
            .expect("read visible column slice");
        assert_eq!(sliced.column_start, 1);
        assert_eq!(
            sliced.rows,
            [[r#"{"id": "abc", "enabled": false}"#.to_owned()]]
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn opens_progressively_before_full_index_is_complete() {
        let path = std::env::temp_dir().join("dataparser_progressive_fixture.csv");
        fs::write(
            &path,
            concat!(
                "id;name\n",
                "1;Alpha\n",
                "2;Beta\n",
                "3;Gamma\n",
                "4;Delta\n",
            ),
        )
        .expect("write csv fixture");

        let mut document =
            CsvDocument::open_progressive(&path, 2).expect("open progressive csv fixture");
        let status = document.index_status();
        assert!(!status.is_complete);
        assert_eq!(status.row_count, 2);

        let visible = document
            .get_rows(0, 4, 0, 2)
            .expect("read currently indexed rows");
        assert_eq!(visible.rows.len(), 2);

        document.index_to_completion().expect("finish indexing");
        let final_status = document.index_status();
        assert!(final_status.is_complete);
        assert_eq!(final_status.row_count, 4);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn opens_root_csv_fixture_when_available() {
        let root_csv = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("cs_applications_per_host.csv");

        if !root_csv.exists() {
            return;
        }

        let mut document = CsvDocument::open(&root_csv).expect("open root csv fixture");
        let summary = document.summarize();

        assert_eq!(summary.delimiter, b';');
        assert_eq!(summary.headers.len(), 23);
        assert!(summary.row_count > 0);
        assert_eq!(document.block_size, DEFAULT_BLOCK_SIZE);
        assert!(document.block_starts.len() > 1);

        let first = document.get_rows(0, 32, 0, 8).expect("read first batch");
        assert_eq!(first.start, 0);
        assert_eq!(first.column_start, 0);
        assert!(!first.rows.is_empty());
        assert!(first.rows.iter().all(|row| row.len() == 8));

        let middle_start = summary.row_count.saturating_sub(512) / 2;
        let middle = document
            .get_rows(middle_start, 32, 4, 6)
            .expect("read middle batch");
        assert_eq!(middle.start, middle_start);
        assert_eq!(middle.column_start, 4);
        assert!(!middle.rows.is_empty());
        assert!(middle.rows.iter().all(|row| row.len() == 6));

        let tail_start = summary.row_count.saturating_sub(32);
        let tail = document
            .get_rows(tail_start, 32, summary.headers.len().saturating_sub(5), 5)
            .expect("read tail batch");
        assert_eq!(tail.start, tail_start);
        assert!(!tail.rows.is_empty());
        assert!(tail.rows.iter().all(|row| row.len() == 5));
    }
}
