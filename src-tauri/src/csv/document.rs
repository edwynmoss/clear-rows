use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

use super::{profile_csv_path, CsvFileProfile, CsvUtf8Parser};

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
}

impl CsvDocument {
    #[cfg(test)]
    pub fn open(path: impl AsRef<Path>) -> Result<Self, CsvError> {
        let mut document = Self::open_progressive(path, 0)?;
        document.index_to_completion()?;
        Ok(document)
    }

    pub fn open_progressive(
        path: impl AsRef<Path>,
        initial_data_rows: usize,
    ) -> Result<Self, CsvError> {
        let path = path.as_ref().to_path_buf();
        let file_size = path.metadata()?.len();
        let profiled = profile_csv_path(&path)?;

        if profiled.profile.binary_like {
            return Err(CsvError::UnsupportedFile(
                "binary-looking content is not supported".to_owned(),
            ));
        }

        let mut index_file = File::open(&path)?;
        index_file.seek(SeekFrom::Start(profiled.data_start))?;
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

        let mut access_file = File::open(&path)?;
        access_file.seek(SeekFrom::Start(profiled.data_start))?;
        let parser = CsvUtf8Parser::new(access_file, delimiter)?;

        let mut document = Self {
            path,
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

fn preview_sliced_row(row: Vec<String>, column_start: usize, column_count: usize) -> Vec<String> {
    let mut preview = Vec::with_capacity(column_count);

    for column_index in column_start..column_start.saturating_add(column_count) {
        let cell = row.get(column_index).cloned().unwrap_or_default();
        preview.push(truncate_cell_preview(cell));
    }

    preview
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
