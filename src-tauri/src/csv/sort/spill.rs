use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use crate::csv::CsvError;

use super::key::EncodedKey;

pub(super) fn write_chunk(path: &Path, keys: &[EncodedKey]) -> Result<(), CsvError> {
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

pub(super) fn merge_chunks(paths: &[PathBuf], total_rows: u64) -> Result<Vec<u64>, CsvError> {
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

pub(super) fn cleanup_spills(paths: &[PathBuf], dir: &Path) {
    for p in paths {
        let _ = fs::remove_file(p);
    }
    let _ = fs::remove_dir_all(dir);
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
