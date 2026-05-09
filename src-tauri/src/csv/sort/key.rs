use std::cmp::Ordering;

use super::mode::{parse_number, SortMode};

/// One row's sort key paired with its physical (header-excluded) row index.
#[derive(Clone)]
pub(super) struct EncodedKey {
    pub key: Vec<u8>,
    pub phys: u64,
}

impl EncodedKey {
    pub fn cmp(a: &EncodedKey, b: &EncodedKey) -> Ordering {
        a.key.cmp(&b.key).then_with(|| a.phys.cmp(&b.phys))
    }
}

/// Build the byte representation that drives the sort. Layout choices:
/// - leading 0xFF tag pushes empty/null cells to the end of the order
/// - leading 0x00 tag for "primary" values (numbers in numeric mode, text in
///   text mode) so they group ahead of fallback cells
/// - leading 0x80 tag for non-numeric strings stuck inside a numeric column;
///   they fall between real numbers and empty cells, matching what users
///   intuitively expect from a "mostly numeric" column with stray labels.
pub(super) fn encode_key(raw: &str, mode: SortMode) -> Vec<u8> {
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
