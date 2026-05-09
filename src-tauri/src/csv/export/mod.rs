use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use super::CsvError;

/// Rows written before publishing the next progress snapshot. Tighter
/// updates pay no IPC cost (status is read on demand) but we still want
/// to avoid lock thrash on hot writer loops.
const PROGRESS_UPDATE_INTERVAL: u64 = 4_096;

/// Rows fetched per chunk from the document. Smaller chunks release the
/// document lock more often so the UI can continue rendering rows while
/// an export is running.
pub const EXPORT_CHUNK_ROWS: usize = 2_048;

#[derive(Clone, Default, Serialize)]
pub struct ExportStatus {
    pub is_running: bool,
    pub is_complete: bool,
    pub target_path: Option<String>,
    pub rows_written: u64,
    pub total_rows: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ExportState {
    pub status: ExportStatus,
}

impl ExportState {
    pub fn idle() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.status = ExportStatus::default();
    }
}

pub struct ExportBuildOptions<F>
where
    F: FnMut(u64, &[u64]) -> Result<Vec<Vec<String>>, CsvError>,
{
    pub target_path: PathBuf,
    pub headers: Vec<String>,
    pub delimiter: u8,
    /// Visible (post-filter, post-sort) physical row indices in display
    /// order. The export walks this in chunks of `EXPORT_CHUNK_ROWS`.
    pub visible_indices: Vec<u64>,
    pub generation: u64,
    pub generation_state: Arc<AtomicU64>,
    pub state: Arc<Mutex<ExportState>>,
    /// Fetch a chunk of rows for the given physical indices. The first
    /// argument is the starting visible-row offset (passed through to
    /// match the existing `get_rows_at_physical_data_indices` signature).
    pub fetch_chunk: F,
}

/// Stream-write the visible rows to `target_path`, atomically replacing
/// any existing file at that path on success. Returns the number of rows
/// written (excluding the header row).
pub fn build_export<F>(mut options: ExportBuildOptions<F>) -> Result<u64, CsvError>
where
    F: FnMut(u64, &[u64]) -> Result<Vec<Vec<String>>, CsvError>,
{
    let total_rows = options.visible_indices.len() as u64;

    // Stage to a sibling temp file so a cancellation or write error never
    // leaves a half-written CSV at the user's target path.
    let temp_path = staging_path(&options.target_path);
    let writer_file = File::create(&temp_path)?;
    let mut writer = BufWriter::with_capacity(64 * 1024, writer_file);

    write_csv_row(&mut writer, &options.headers, options.delimiter)?;

    let mut written: u64 = 0;
    let mut cursor: usize = 0;
    let total = options.visible_indices.len();

    while cursor < total {
        if !is_active(&options.generation_state, options.generation) {
            // Cancelled — drop the partial file.
            drop(writer);
            let _ = fs::remove_file(&temp_path);
            return Ok(written);
        }

        let end = (cursor + EXPORT_CHUNK_ROWS).min(total);
        let chunk = &options.visible_indices[cursor..end];
        let visible_start = cursor as u64;

        let rows = (options.fetch_chunk)(visible_start, chunk)?;
        for row in rows.iter() {
            write_csv_row(&mut writer, row, options.delimiter)?;
            written += 1;
            if written % PROGRESS_UPDATE_INTERVAL == 0 {
                let mut s = options.state.lock();
                s.status.rows_written = written;
                s.status.total_rows = total_rows;
            }
        }

        cursor = end;
    }

    writer.flush()?;
    drop(writer);

    // Replace target atomically. On Windows `rename` fails if the
    // destination exists, so remove first — best effort, since the user
    // chose this path explicitly via the save dialog.
    if options.target_path.exists() {
        let _ = fs::remove_file(&options.target_path);
    }
    fs::rename(&temp_path, &options.target_path)?;

    if !is_active(&options.generation_state, options.generation) {
        return Ok(written);
    }

    let mut s = options.state.lock();
    s.status.is_running = false;
    s.status.is_complete = true;
    s.status.target_path = Some(options.target_path.to_string_lossy().into_owned());
    s.status.rows_written = written;
    s.status.total_rows = total_rows;
    s.status.error = None;
    Ok(written)
}

fn staging_path(target: &Path) -> PathBuf {
    let mut staged = target.to_path_buf();
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".to_owned());
    staged.set_file_name(format!(".{}.clearrows-tmp", name));
    staged
}

fn write_csv_row<W: Write>(writer: &mut W, row: &[String], delimiter: u8) -> Result<(), CsvError> {
    for (idx, field) in row.iter().enumerate() {
        if idx > 0 {
            writer.write_all(&[delimiter])?;
        }
        if needs_quoting(field, delimiter) {
            writer.write_all(b"\"")?;
            for byte in field.as_bytes() {
                if *byte == b'"' {
                    writer.write_all(b"\"\"")?;
                } else {
                    writer.write_all(std::slice::from_ref(byte))?;
                }
            }
            writer.write_all(b"\"")?;
        } else {
            writer.write_all(field.as_bytes())?;
        }
    }
    writer.write_all(b"\n")?;
    Ok(())
}

/// RFC 4180 quoting rules: quote when the field contains the delimiter,
/// a double quote, CR, or LF.
fn needs_quoting(field: &str, delimiter: u8) -> bool {
    field
        .as_bytes()
        .iter()
        .any(|&b| b == delimiter || b == b'"' || b == b'\n' || b == b'\r')
}

fn is_active(generation_state: &Arc<AtomicU64>, generation: u64) -> bool {
    generation_state.load(AtomicOrdering::SeqCst) == generation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_fields_containing_delimiter() {
        let mut buf: Vec<u8> = Vec::new();
        write_csv_row(&mut buf, &["a".into(), "b,c".into(), "d".into()], b',').unwrap();
        assert_eq!(buf, b"a,\"b,c\",d\n");
    }

    #[test]
    fn escapes_embedded_double_quotes() {
        let mut buf: Vec<u8> = Vec::new();
        write_csv_row(&mut buf, &[r#"he said "hi""#.into()], b',').unwrap();
        assert_eq!(buf, b"\"he said \"\"hi\"\"\"\n");
    }

    #[test]
    fn quotes_fields_containing_newline() {
        let mut buf: Vec<u8> = Vec::new();
        write_csv_row(&mut buf, &["a\nb".into()], b',').unwrap();
        assert_eq!(buf, b"\"a\nb\"\n");
    }

    #[test]
    fn passes_through_plain_ascii_unquoted() {
        let mut buf: Vec<u8> = Vec::new();
        write_csv_row(&mut buf, &["one".into(), "two".into(), "three".into()], b',').unwrap();
        assert_eq!(buf, b"one,two,three\n");
    }

    #[test]
    fn build_export_writes_header_and_visible_rows() {
        let target = std::env::temp_dir().join("clear_rows_export_basic.csv");
        let _ = fs::remove_file(&target);

        let state = Arc::new(Mutex::new(ExportState::idle()));
        let generation_state = Arc::new(AtomicU64::new(1));

        // Simulated source rows. Visible order skips row 1 and reverses the rest.
        let source: Vec<Vec<String>> = vec![
            vec!["alice".into(), "1".into()],
            vec!["bob".into(), "2".into()],
            vec!["charlie".into(), "3".into()],
        ];
        let visible: Vec<u64> = vec![2, 0]; // charlie, alice

        let written = build_export(ExportBuildOptions {
            target_path: target.clone(),
            headers: vec!["name".into(), "n".into()],
            delimiter: b',',
            visible_indices: visible,
            generation: 1,
            generation_state: Arc::clone(&generation_state),
            state: Arc::clone(&state),
            fetch_chunk: |_start: u64, indices: &[u64]| {
                Ok(indices
                    .iter()
                    .map(|&i| source[i as usize].clone())
                    .collect())
            },
        })
        .expect("export ok");

        assert_eq!(written, 2);
        let body = fs::read_to_string(&target).expect("read target");
        assert_eq!(body, "name,n\ncharlie,3\nalice,1\n");

        let _ = fs::remove_file(&target);
    }
}
