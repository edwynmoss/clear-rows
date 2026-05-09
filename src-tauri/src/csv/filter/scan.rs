use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::Path;

use crate::csv::parser::CsvUtf8Parser;
use crate::csv::CsvError;

/// Stream the CSV body and collect physical row indices whose lowercased row
/// content contains `needle`. The callback is invoked after every row with
/// `(rows_scanned_so_far, rows_matched_so_far)` and returning `false` aborts
/// the scan early — the caller uses this to check the cancellation generation
/// and to publish progress updates.
pub(super) fn scan_filter(
    source_path: &Path,
    data_start: u64,
    delimiter: u8,
    needle: &str,
    mut on_progress: impl FnMut(u64, u64) -> bool,
) -> Result<Vec<u64>, CsvError> {
    let mut file = File::open(source_path)?;
    file.seek(SeekFrom::Start(data_start))?;
    let mut parser = CsvUtf8Parser::new(file, delimiter)?;
    parser.try_skip_row()?; // header

    let mut mask: Vec<u64> = Vec::new();
    let mut phys_idx: u64 = 0;
    let mut scanned: u64 = 0;
    let mut buf = String::new();

    while let Some(row) = parser.try_read_row()? {
        if row_contains(&row, needle, &mut buf) {
            mask.push(phys_idx);
        }
        phys_idx += 1;
        scanned += 1;
        if !on_progress(scanned, mask.len() as u64) {
            // Cancelled — bail out without finalising.
            return Ok(Vec::new());
        }
    }

    Ok(mask)
}

/// Case-insensitive substring search across all cells of `row`. Reuses
/// `buf` to avoid per-row allocations on the hot path.
fn row_contains(row: &[String], needle_lower: &str, buf: &mut String) -> bool {
    for cell in row {
        if cell.is_empty() {
            continue;
        }
        // Fast path when the cell is already ASCII-lower (common). We still
        // need a lowercase copy for non-ASCII or mixed-case cells, so always
        // produce one — but reuse the same String across rows.
        buf.clear();
        for ch in cell.chars() {
            for lower in ch.to_lowercase() {
                buf.push(lower);
            }
        }
        if buf.contains(needle_lower) {
            return true;
        }
    }
    false
}
