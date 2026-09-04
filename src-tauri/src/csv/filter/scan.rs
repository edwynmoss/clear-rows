use std::path::Path;

use rayon::prelude::*;

use crate::csv::scan::{BlockIndex, FileMap, RowScanner};
use crate::csv::CsvError;

use super::query::CompiledQuery;

/// Physical rows between checkpoints when we have to build an index ourselves.
const FALLBACK_BLOCK_SIZE: u64 = 1024;
/// Blocks scanned per parallel batch; progress and cancellation are checked
/// between batches (64 blocks ≈ 65k rows).
const BLOCKS_PER_BATCH: usize = 64;

/// Scan the file block by block in parallel and collect the physical data row
/// indices (header excluded) that satisfy `query`, ascending.
///
/// `on_progress(rows_scanned, rows_matched)` is called after each batch;
/// returning `false` cancels the scan, in which case an empty mask is returned.
pub(super) fn scan_filter(
    source_path: &Path,
    data_start: u64,
    delimiter: u8,
    blocks: Option<BlockIndex>,
    query: &CompiledQuery,
    mut on_progress: impl FnMut(u64, u64) -> bool,
) -> Result<Vec<u64>, CsvError> {
    let map = FileMap::open(source_path)?;
    let bytes = map.bytes();
    let index = blocks.unwrap_or_else(|| BlockIndex::build(bytes, data_start, delimiter, FALLBACK_BLOCK_SIZE));
    let ranges = index.ranges();

    let mut mask: Vec<u64> = Vec::new();
    let mut scanned: u64 = 0;

    for batch in ranges.chunks(BLOCKS_PER_BATCH) {
        let results: Vec<(u64, Vec<u64>)> = batch
            .par_iter()
            .map(|&(_, first_row, start, end)| {
                let end = end.min(bytes.len());
                let slice = &bytes[start.min(end)..end];
                let mut scanner = RowScanner::new(slice, 0, delimiter);
                let mut fields = Vec::with_capacity(32);
                let mut unescape = Vec::new();
                let mut lower = Vec::new();
                let mut hits = Vec::new();
                let mut phys = first_row;
                let mut rows = 0u64;
                while scanner.next_row(&mut fields) {
                    if phys > 0 && query.matches_fields(slice, &fields, &mut unescape, &mut lower) {
                        hits.push(phys - 1);
                    }
                    phys += 1;
                    rows += 1;
                }
                (rows, hits)
            })
            .collect();

        for (rows, hits) in results {
            scanned += rows;
            mask.extend(hits);
        }
        if !on_progress(scanned, mask.len() as u64) {
            return Ok(Vec::new());
        }
    }

    Ok(mask)
}
