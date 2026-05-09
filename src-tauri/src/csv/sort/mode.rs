use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::Path;

use crate::csv::parser::CsvUtf8Parser;
use crate::csv::CsvError;

/// Rows sampled (cheaply) at the start of a sort to decide whether the column
/// behaves as numeric or text. Anything beyond a couple thousand rows changes
/// the verdict only at the margins and adds noticeable latency to short sorts.
const SAMPLE_ROWS_FOR_MODE: usize = 2_000;

/// Fraction of non-empty samples that must parse as f64 for us to treat the
/// column as numeric. Below this we fall back to text ordering so a single
/// stray "n/a" row in a numeric column still sorts numerically, while a
/// mostly-text column with a few embedded numbers stays in lex order.
const NUMERIC_RATIO_THRESHOLD: f64 = 0.8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SortMode {
    Numeric,
    Text,
}

pub(super) fn detect_mode(
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

pub(super) fn parse_number(s: &str) -> Option<f64> {
    let v: f64 = s.parse().ok()?;
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

pub(super) fn open_parser(
    source_path: &Path,
    data_start: u64,
    delimiter: u8,
) -> Result<CsvUtf8Parser<File>, CsvError> {
    let mut file = File::open(source_path)?;
    file.seek(SeekFrom::Start(data_start))?;
    let parser = CsvUtf8Parser::new(file, delimiter)?;
    Ok(parser)
}
