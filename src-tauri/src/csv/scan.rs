//! Fast, allocation-free row scanning over memory-mapped bytes, plus a
//! parallel driver that walks the file block by block using the row index.
//!
//! The scanner reproduces `CsvUtf8Parser`'s row and field rules exactly:
//! a field is quoted only if its first byte is `"`, `""` inside quotes is a
//! literal quote, after a closing quote spaces and tabs are skipped and any
//! other byte ends the row, unquoted fields run to the delimiter or a row
//! terminator, and terminators are `\n`, `\r\n`, `\r\r\n` or a lone `\r`.

use std::fs::File;
use std::io;
use std::path::Path;

use memchr::{memchr, memchr3};
use memmap2::Mmap;
use rayon::prelude::*;

/// A field's byte span. For quoted fields the span is the content between
/// the quotes and may still contain `""` escapes; use `field_bytes` to get
/// the final value.
#[derive(Clone, Copy, Debug, Default)]
pub struct Field {
    pub start: usize,
    pub end: usize,
    pub quoted: bool,
}

pub struct RowScanner<'a> {
    bytes: &'a [u8],
    pos: usize,
    delimiter: u8,
}

impl<'a> RowScanner<'a> {
    pub fn new(bytes: &'a [u8], start: usize, delimiter: u8) -> Self {
        Self { bytes, pos: start.min(bytes.len()), delimiter }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    /// Parse the next row into `fields`. Returns false at end of input.
    pub fn next_row(&mut self, fields: &mut Vec<Field>) -> bool {
        fields.clear();
        self.scan_row(Some(fields))
    }

    /// Advance past the next row without recording fields.
    pub fn skip_row(&mut self) -> bool {
        self.scan_row(None)
    }

    fn scan_row(&mut self, mut fields: Option<&mut Vec<Field>>) -> bool {
        let bytes = self.bytes;
        let len = bytes.len();
        if self.pos >= len {
            return false;
        }
        loop {
            // A field starts here. An empty trailing field after a delimiter
            // at EOF is still a field (matches the streaming parser).
            if self.pos >= len {
                if let Some(f) = fields.as_deref_mut() {
                    f.push(Field { start: len, end: len, quoted: false });
                }
                return true;
            }
            if bytes[self.pos] == b'"' {
                let content_start = self.pos + 1;
                let mut cursor = content_start;
                let content_end;
                loop {
                    match memchr(b'"', &bytes[cursor..]) {
                        None => {
                            // Unterminated quote: field runs to EOF and the row ends.
                            if let Some(f) = fields.as_deref_mut() {
                                f.push(Field { start: content_start, end: len, quoted: true });
                            }
                            self.pos = len;
                            return true;
                        }
                        Some(offset) => {
                            let q = cursor + offset;
                            if q + 1 < len && bytes[q + 1] == b'"' {
                                cursor = q + 2;
                                continue;
                            }
                            content_end = q;
                            self.pos = q + 1;
                            break;
                        }
                    }
                }
                if let Some(f) = fields.as_deref_mut() {
                    f.push(Field { start: content_start, end: content_end, quoted: true });
                }
                // After the closing quote: delimiter, terminator, whitespace, or anything else ends the row.
                loop {
                    if self.pos >= len {
                        return true;
                    }
                    let b = bytes[self.pos];
                    if b == self.delimiter {
                        self.pos += 1;
                        break;
                    }
                    if let Some(width) = terminator_width(bytes, self.pos) {
                        self.pos += width;
                        return true;
                    }
                    if b == b' ' || b == b'\t' {
                        self.pos += 1;
                        continue;
                    }
                    return true;
                }
                continue;
            }

            // Unquoted field.
            let start = self.pos;
            let mut cursor = start;
            loop {
                let Some(offset) = memchr3(self.delimiter, b'\n', b'\r', &bytes[cursor..]) else {
                    if let Some(f) = fields.as_deref_mut() {
                        f.push(Field { start, end: len, quoted: false });
                    }
                    self.pos = len;
                    return true;
                };
                let idx = cursor + offset;
                let b = bytes[idx];
                if b == self.delimiter {
                    if let Some(f) = fields.as_deref_mut() {
                        f.push(Field { start, end: idx, quoted: false });
                    }
                    self.pos = idx + 1;
                    break;
                }
                if let Some(width) = terminator_width(bytes, idx) {
                    if let Some(f) = fields.as_deref_mut() {
                        f.push(Field { start, end: idx, quoted: false });
                    }
                    self.pos = idx + width;
                    return true;
                }
                // A '\r' that is not a terminator cannot happen (lone \r is one),
                // but keep scanning defensively.
                cursor = idx + 1;
            }
        }
    }
}

/// Width of the row terminator starting at `pos`, or None if `pos` is not one.
#[inline]
fn terminator_width(bytes: &[u8], pos: usize) -> Option<usize> {
    match bytes.get(pos) {
        Some(b'\n') => Some(1),
        Some(b'\r') => {
            if bytes.get(pos + 1) == Some(&b'\r') && bytes.get(pos + 2) == Some(&b'\n') {
                Some(3)
            } else if bytes.get(pos + 1) == Some(&b'\n') {
                Some(2)
            } else {
                Some(1)
            }
        }
        _ => None,
    }
}

/// The raw bytes of a field, unescaping `""` for quoted fields into `scratch`.
#[inline]
pub fn field_bytes<'b>(bytes: &'b [u8], field: &Field, scratch: &'b mut Vec<u8>) -> &'b [u8] {
    let raw = &bytes[field.start..field.end.max(field.start)];
    if !field.quoted || memchr(b'"', raw).is_none() {
        return raw;
    }
    scratch.clear();
    let mut i = 0;
    while i < raw.len() {
        let b = raw[i];
        scratch.push(b);
        if b == b'"' && i + 1 < raw.len() && raw[i + 1] == b'"' {
            i += 2;
        } else {
            i += 1;
        }
    }
    scratch.as_slice()
}

/// The field as text (lossy for invalid UTF-8, matching the streaming parser).
pub fn field_string(bytes: &[u8], field: &Field, scratch: &mut Vec<u8>) -> String {
    String::from_utf8_lossy(field_bytes(bytes, field, scratch)).into_owned()
}

/// Memory map of a file, read-only.
pub struct FileMap {
    map: Mmap,
}

impl FileMap {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        // SAFETY: the file is opened read-only and the app never writes to
        // source files while a document is open; a concurrent external
        // truncation would at worst produce a read fault, which we accept
        // for a local desktop tool reading its own inputs.
        let map = unsafe { Mmap::map(&file)? };
        Ok(Self { map })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.map
    }
}

/// Byte offsets of every `block_size`-th physical row (row 0 is the header),
/// plus where the indexed region ends.
#[derive(Clone, Debug)]
pub struct BlockIndex {
    pub starts: Vec<u64>,
    pub block_size: u64,
    pub end: u64,
}

impl BlockIndex {
    /// Build an index by scanning `bytes` from `data_start`. Used when no
    /// document index is available (tests, ad-hoc files).
    pub fn build(bytes: &[u8], data_start: u64, delimiter: u8, block_size: u64) -> Self {
        let mut scanner = RowScanner::new(bytes, data_start as usize, delimiter);
        let mut starts = Vec::new();
        let mut row: u64 = 0;
        loop {
            if row % block_size == 0 {
                starts.push(scanner.position() as u64);
            }
            if !scanner.skip_row() {
                break;
            }
            row += 1;
        }
        // The loop pushes a start for the position after the final row when
        // the row count is a multiple of block_size; drop it.
        if starts.last().copied() == Some(scanner.position() as u64) && row % block_size == 0 && row > 0 {
            starts.pop();
        }
        Self { starts, block_size, end: scanner.position() as u64 }
    }

    /// `(block, first_physical_row, byte_start, byte_end)` for each block.
    pub fn ranges(&self) -> Vec<(usize, u64, usize, usize)> {
        let mut out = Vec::with_capacity(self.starts.len());
        for (i, &start) in self.starts.iter().enumerate() {
            let end = self.starts.get(i + 1).copied().unwrap_or(self.end);
            out.push((i, i as u64 * self.block_size, start as usize, end as usize));
        }
        out
    }
}

/// Byte offset of each wanted physical *data* row (header excluded, so data
/// row 0 is physical row 1). `wanted` must be sorted ascending; the result is
/// aligned with it. Rows past the indexed region get `bytes.len()`.
pub fn row_offsets(bytes: &[u8], index: &BlockIndex, delimiter: u8, wanted: &[u64]) -> Vec<usize> {
    let ranges = index.ranges();
    let per_block: Vec<Vec<usize>> = ranges
        .par_iter()
        .map(|&(_, first_row, start, end)| {
            let last_row = first_row + index.block_size; // exclusive, physical
            // Wanted data rows inside this block: physical = data + 1.
            let lo = wanted.partition_point(|&d| d + 1 < first_row);
            let hi = wanted.partition_point(|&d| d + 1 < last_row);
            let mut out = Vec::with_capacity(hi - lo);
            if lo == hi {
                return out;
            }
            let end = end.min(bytes.len());
            let mut scanner = RowScanner::new(bytes, start.min(end), delimiter);
            let mut phys = first_row;
            let mut cursor = lo;
            while cursor < hi {
                let target = wanted[cursor] + 1;
                while phys < target {
                    if scanner.position() >= end || !scanner.skip_row() {
                        break;
                    }
                    phys += 1;
                }
                out.push(if phys == target { scanner.position().min(end) } else { bytes.len() });
                cursor += 1;
            }
            out
        })
        .collect();
    let mut offsets = Vec::with_capacity(wanted.len());
    for block in per_block {
        offsets.extend(block);
    }
    offsets
}

/// Run `f` over every block in parallel; results come back in block order.
#[allow(dead_code)]
/// `f` receives the block's first physical row number (row 0 is the header)
/// and the block's bytes.
pub fn par_scan_blocks<T, F>(bytes: &[u8], index: &BlockIndex, f: F) -> Vec<T>
where
    T: Send,
    F: Fn(usize, u64, &[u8]) -> T + Sync,
{
    index
        .ranges()
        .into_par_iter()
        .map(|(block, first_row, start, end)| {
            let end = end.min(bytes.len());
            let start = start.min(end);
            f(block, first_row, &bytes[start..end])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(input: &str, delimiter: u8) -> Vec<Vec<String>> {
        let bytes = input.as_bytes();
        let mut scanner = RowScanner::new(bytes, 0, delimiter);
        let mut fields = Vec::new();
        let mut scratch = Vec::new();
        let mut out = Vec::new();
        while scanner.next_row(&mut fields) {
            out.push(fields.iter().map(|f| field_string(bytes, f, &mut scratch)).collect());
        }
        out
    }

    fn streaming(input: &str, delimiter: u8) -> Vec<Vec<String>> {
        let mut parser = crate::csv::parser::CsvUtf8Parser::new(std::io::Cursor::new(input.as_bytes().to_vec()), delimiter).unwrap();
        let mut out = Vec::new();
        while let Some(row) = parser.try_read_row().unwrap() {
            out.push(row);
        }
        out
    }

    #[test]
    fn matches_streaming_parser_on_awkward_input() {
        let cases = [
            "a,b,c\n1,2,3\n",
            "a,b\n1,\"two, with comma\"\n\"quoted \"\"inner\"\" text\",x\n",
            "a,b\r\n1,2\r\n3,4",
            "a,b\r\r\n1,2\r3,4\n",
            "id,comment\n1,\"line one\nline two\"\n2,plain\n",
            "a,b,\n1,2,\n\n3,4,5\n",
            "\"unterminated,x\n",
            "\"q\"  ,after\n\"q\"junk,y\n",
            "x;y\n\"1\";\"2\"\n",
            "",
            "\n",
            "solo",
        ];
        for case in cases {
            let delimiter = if case.contains(';') { b';' } else { b',' };
            assert_eq!(rows(case, delimiter), streaming(case, delimiter), "input {case:?}");
        }
    }

    #[test]
    fn block_index_and_parallel_scan_cover_every_row() {
        let mut text = String::from("id,value\n");
        for i in 0..5000 {
            text.push_str(&format!("{i},\"v{i}\"\n"));
        }
        let bytes = text.as_bytes();
        let index = BlockIndex::build(bytes, 0, b',', 1024);
        assert_eq!(index.starts.len(), 5); // 5001 physical rows / 1024 → 5 blocks
        let counts = par_scan_blocks(bytes, &index, |_, first_row, slice| {
            let mut scanner = RowScanner::new(slice, 0, b',');
            let mut n = 0u64;
            while scanner.skip_row() {
                n += 1;
            }
            (first_row, n)
        });
        let total: u64 = counts.iter().map(|(_, n)| n).sum();
        assert_eq!(total, 5001);
        assert_eq!(counts[1].0, 1024);
    }
}
