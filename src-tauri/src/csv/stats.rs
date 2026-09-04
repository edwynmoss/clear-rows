//! Column statistics for the "Inspect column" panel: how many rows, how
//! many empty, how many distinct values, the most common values with
//! counts, and type-aware ranges. Computed over the rows in the current
//! view (the filter mask when one is active) by scanning blocks in
//! parallel, the same way filters run.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use rayon::prelude::*;
use serde::Serialize;

use super::scan::{field_bytes, BlockIndex, FileMap, RowScanner};
use super::types::{parse_datetime, parse_number, ColumnProfile};
use super::CsvError;

/// Distinct values tracked per worker before it stops learning new ones.
const WORKER_DISTINCT_CAP: usize = 100_000;
/// Distinct values kept after merging; beyond this the count is a lower bound.
const MERGED_DISTINCT_CAP: usize = 250_000;
/// Blocks per parallel batch; cancellation is checked between batches.
const BLOCKS_PER_BATCH: usize = 64;
const FALLBACK_BLOCK_SIZE: u64 = 1024;

pub struct ColumnStatsOptions {
    pub source_path: PathBuf,
    pub data_start: u64,
    pub delimiter: u8,
    pub blocks: Option<BlockIndex>,
    pub column: usize,
    pub profile: ColumnProfile,
    /// Sorted physical data row indices in view, or None for every row.
    pub mask: Option<Arc<Vec<u64>>>,
    pub top_n: usize,
    pub generation: u64,
    pub generation_state: Arc<AtomicU64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TopValue {
    pub value: String,
    pub count: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NumericStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub sum: f64,
    /// Cells that parsed as numbers.
    pub parsed: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TemporalStats {
    pub earliest: String,
    pub latest: String,
    pub parsed: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TextStats {
    pub shortest: u64,
    pub longest: u64,
    pub mean_length: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ColumnStats {
    pub column: usize,
    /// Rows examined (the current view).
    pub rows: u64,
    pub empty: u64,
    pub distinct: u64,
    /// True when more distinct values exist than were tracked.
    pub distinct_is_lower_bound: bool,
    pub top: Vec<TopValue>,
    pub numeric: Option<NumericStats>,
    pub temporal: Option<TemporalStats>,
    pub text: Option<TextStats>,
    pub cancelled: bool,
}

#[derive(Default)]
struct Partial {
    rows: u64,
    empty: u64,
    counts: HashMap<Vec<u8>, u64>,
    overflow: bool,
    num_count: u64,
    num_sum: f64,
    num_min: f64,
    num_max: f64,
    time_count: u64,
    time_min: i64,
    time_max: i64,
    time_min_text: Vec<u8>,
    time_max_text: Vec<u8>,
    len_min: u64,
    len_max: u64,
    len_sum: u64,
}

impl Partial {
    fn new() -> Self {
        Self {
            num_min: f64::INFINITY,
            num_max: f64::NEG_INFINITY,
            time_min: i64::MAX,
            time_max: i64::MIN,
            len_min: u64::MAX,
            ..Default::default()
        }
    }

    fn observe(&mut self, cell: &[u8], profile: ColumnProfile) {
        self.rows += 1;
        let trimmed = trim_ascii(cell);
        if trimmed.is_empty() {
            self.empty += 1;
            return;
        }
        let length = trimmed.len() as u64;
        self.len_min = self.len_min.min(length);
        self.len_max = self.len_max.max(length);
        self.len_sum += length;

        if let Some(count) = self.counts.get_mut(trimmed) {
            *count += 1;
        } else if self.counts.len() < WORKER_DISTINCT_CAP {
            self.counts.insert(trimmed.to_vec(), 1);
        } else {
            self.overflow = true;
        }

        if profile.kind.is_numeric() || profile.kind.is_temporal() {
            if let Ok(text) = std::str::from_utf8(trimmed) {
                if profile.kind.is_numeric() {
                    if let Some(value) = parse_number(text) {
                        self.num_count += 1;
                        self.num_sum += value;
                        self.num_min = self.num_min.min(value);
                        self.num_max = self.num_max.max(value);
                    }
                } else if let Some(millis) = parse_datetime(text, profile.date_order) {
                    self.time_count += 1;
                    if millis < self.time_min {
                        self.time_min = millis;
                        self.time_min_text = trimmed.to_vec();
                    }
                    if millis > self.time_max {
                        self.time_max = millis;
                        self.time_max_text = trimmed.to_vec();
                    }
                }
            }
        }
    }

    fn merge(&mut self, other: Partial) {
        self.rows += other.rows;
        self.empty += other.empty;
        self.overflow |= other.overflow;
        for (value, count) in other.counts {
            if let Some(existing) = self.counts.get_mut(&value) {
                *existing += count;
            } else if self.counts.len() < MERGED_DISTINCT_CAP {
                self.counts.insert(value, count);
            } else {
                self.overflow = true;
            }
        }
        self.num_count += other.num_count;
        self.num_sum += other.num_sum;
        self.num_min = self.num_min.min(other.num_min);
        self.num_max = self.num_max.max(other.num_max);
        if other.time_count > 0 {
            self.time_count += other.time_count;
            if other.time_min < self.time_min {
                self.time_min = other.time_min;
                self.time_min_text = other.time_min_text;
            }
            if other.time_max > self.time_max {
                self.time_max = other.time_max;
                self.time_max_text = other.time_max_text;
            }
        }
        self.len_min = self.len_min.min(other.len_min);
        self.len_max = self.len_max.max(other.len_max);
        self.len_sum += other.len_sum;
    }
}

fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(start, |i| i + 1);
    &bytes[start..end.max(start)]
}

pub fn compute_column_stats(options: ColumnStatsOptions) -> Result<ColumnStats, CsvError> {
    let ColumnStatsOptions { source_path, data_start, delimiter, blocks, column, profile, mask, top_n, generation, generation_state } = options;
    let map = FileMap::open(&source_path)?;
    let bytes = map.bytes();
    let index = blocks.unwrap_or_else(|| BlockIndex::build(bytes, data_start, delimiter, FALLBACK_BLOCK_SIZE));
    let ranges = index.ranges();
    let mask_ref = mask.as_deref().map(Vec::as_slice);

    let mut total = Partial::new();
    let mut cancelled = false;

    for batch in ranges.chunks(BLOCKS_PER_BATCH) {
        let partials: Vec<Partial> = batch
            .par_iter()
            .map(|&(_, first_row, start, end)| {
                let end = end.min(bytes.len());
                let slice = &bytes[start.min(end)..end];
                let mut scanner = RowScanner::new(slice, 0, delimiter);
                let mut fields = Vec::with_capacity(32);
                let mut unescape = Vec::new();
                let mut partial = Partial::new();

                // Rows in this block are physical first_row.. ; data index = phys - 1.
                // With a mask, walk the sorted slice of wanted indices alongside.
                let block_first_data = first_row.saturating_sub(1);
                let mut wanted: &[u64] = &[];
                if let Some(mask) = mask_ref {
                    let lo = mask.partition_point(|&r| r < block_first_data);
                    wanted = &mask[lo..];
                }
                let mut wanted_pos = 0usize;
                let mut phys = first_row;
                while scanner.next_row(&mut fields) {
                    if phys > 0 {
                        let data_index = phys - 1;
                        let take = if mask_ref.is_some() {
                            while wanted_pos < wanted.len() && wanted[wanted_pos] < data_index {
                                wanted_pos += 1;
                            }
                            if wanted_pos >= wanted.len() {
                                break;
                            }
                            wanted[wanted_pos] == data_index
                        } else {
                            true
                        };
                        if take {
                            let cell: &[u8] = match fields.get(column) {
                                Some(field) => field_bytes(slice, field, &mut unescape),
                                None => &[],
                            };
                            partial.observe(cell, profile);
                        }
                    }
                    phys += 1;
                }
                partial
            })
            .collect();

        for partial in partials {
            total.merge(partial);
        }
        if generation_state.load(Ordering::SeqCst) != generation {
            cancelled = true;
            break;
        }
    }

    let mut ranked: Vec<(Vec<u8>, u64)> = total.counts.into_iter().collect();
    let distinct = ranked.len() as u64;
    ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(top_n);
    let top = ranked
        .into_iter()
        .map(|(value, count)| TopValue { value: String::from_utf8_lossy(&value).into_owned(), count })
        .collect();

    let non_empty = total.rows.saturating_sub(total.empty);
    let numeric = (profile.kind.is_numeric() && total.num_count > 0).then(|| NumericStats {
        min: total.num_min,
        max: total.num_max,
        mean: total.num_sum / total.num_count as f64,
        sum: total.num_sum,
        parsed: total.num_count,
    });
    let temporal = (profile.kind.is_temporal() && total.time_count > 0).then(|| TemporalStats {
        earliest: String::from_utf8_lossy(&total.time_min_text).into_owned(),
        latest: String::from_utf8_lossy(&total.time_max_text).into_owned(),
        parsed: total.time_count,
    });
    let text = (non_empty > 0).then(|| TextStats {
        shortest: total.len_min,
        longest: total.len_max,
        mean_length: total.len_sum as f64 / non_empty as f64,
    });

    Ok(ColumnStats {
        column,
        rows: total.rows,
        empty: total.empty,
        distinct,
        distinct_is_lower_bound: total.overflow,
        top,
        numeric,
        temporal,
        text,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::csv::types::{ColumnType, DateOrder};
    use std::fs;

    fn options(path: &std::path::Path, column: usize, kind: ColumnType, mask: Option<Vec<u64>>) -> ColumnStatsOptions {
        ColumnStatsOptions {
            source_path: path.to_path_buf(),
            data_start: 0,
            delimiter: b',',
            blocks: None,
            column,
            profile: ColumnProfile { kind, date_order: DateOrder::DayFirst },
            mask: mask.map(Arc::new),
            top_n: 3,
            generation: 1,
            generation_state: Arc::new(AtomicU64::new(1)),
        }
    }

    #[test]
    fn counts_values_and_ranges() {
        let path = std::env::temp_dir().join(format!("clear_rows_stats_{}.csv", std::process::id()));
        fs::write(
            &path,
            "process,amount,when\ncmd.exe,10,2026-08-03\nchrome.exe,2.5,2026-08-01\ncmd.exe,,2026-08-02\n\"cmd.exe\",7,\nmshta.exe,n/a,2026-08-05\n",
        )
        .unwrap();

        let stats = compute_column_stats(options(&path, 0, ColumnType::Text, None)).unwrap();
        assert_eq!(stats.rows, 5);
        assert_eq!(stats.empty, 0);
        assert_eq!(stats.distinct, 3);
        assert_eq!(stats.top[0].value, "cmd.exe");
        assert_eq!(stats.top[0].count, 3);
        assert_eq!(stats.text.as_ref().unwrap().longest, 10);

        let stats = compute_column_stats(options(&path, 1, ColumnType::Decimal, None)).unwrap();
        assert_eq!(stats.empty, 1);
        let numeric = stats.numeric.unwrap();
        assert_eq!(numeric.parsed, 3);
        assert_eq!(numeric.min, 2.5);
        assert_eq!(numeric.max, 10.0);
        assert_eq!(numeric.sum, 19.5);

        let stats = compute_column_stats(options(&path, 2, ColumnType::Date, None)).unwrap();
        let temporal = stats.temporal.unwrap();
        assert_eq!(temporal.earliest, "2026-08-01");
        assert_eq!(temporal.latest, "2026-08-05");
        assert_eq!(temporal.parsed, 4);

        // Only rows 0, 2 and 3 in view: cmd.exe three times, nothing else.
        let stats = compute_column_stats(options(&path, 0, ColumnType::Text, Some(vec![0, 2, 3]))).unwrap();
        assert_eq!(stats.rows, 3);
        assert_eq!(stats.distinct, 1);
        assert_eq!(stats.top[0].count, 3);

        let _ = fs::remove_file(path);
    }
}
