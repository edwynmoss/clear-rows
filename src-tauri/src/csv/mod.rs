mod delimiter;
mod document;
mod export;
mod filter;
mod parser;
mod profile;
mod search;
mod sort;

pub use document::{CsvDocument, CsvError, IndexStatus, OpenOptions, OpenSummary, RowBatch};
pub use export::{build_export, ExportBuildOptions, ExportState, ExportStatus};
pub use filter::{build_filter, FilterBuildOptions, FilterState, FilterStatus};
pub use parser::CsvUtf8Parser;
pub use profile::{profile_csv_path, CsvFileProfile};
pub use search::{
    default_max_matches, search_csv_files_with_progress, CsvSearchProgress, CsvSearchSummary,
};
pub use sort::{build_sort, SortBuildOptions, SortKey, SortState, SortStatus};

#[cfg(test)]
mod encoding_integration {
    use super::*;
    use std::sync::{atomic::AtomicU64, Arc};

    fn search_one(path: &std::path::Path, needle: &str) -> CsvSearchSummary {
        search_csv_files_with_progress(
            vec![path.to_string_lossy().into_owned()],
            needle.to_owned(),
            10,
            1,
            Arc::new(AtomicU64::new(1)),
            |_| {},
        )
    }

    #[test]
    fn search_reads_utf16_files_through_the_utf8_view() {
        let path = std::env::temp_dir().join("clear_rows_search_utf16.csv");
        let text = "id,name\n1,Zoë Müller\n2,José\n";
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
        std::fs::write(&path, &bytes).unwrap();

        let summary = search_one(&path, "Müller");
        assert!(summary.errors.is_empty(), "{:?}", summary.errors.len());
        assert_eq!(summary.matches.len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn search_reads_windows_1252_files() {
        let path = std::env::temp_dir().join("clear_rows_search_cp1252.csv");
        std::fs::write(&path, b"id,name\n1,Zo\xEB M\xFCller\n2,Jos\xE9\n").unwrap();

        let summary = search_one(&path, "José");
        assert_eq!(summary.matches.len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn document_opens_windows_1252_and_decodes_cells() {
        let path = std::env::temp_dir().join("clear_rows_doc_cp1252.csv");
        std::fs::write(&path, b"id,name\n1,Zo\xEB M\xFCller\n2,Jos\xE9\n").unwrap();

        let mut doc = CsvDocument::open_progressive_with_options(&path, 16, OpenOptions::default()).unwrap();
        doc.index_to_completion().unwrap();
        let batch = doc.get_rows(0, 2, 0, 8).unwrap();
        assert_eq!(batch.rows[0][1], "Zoë Müller");
        assert_eq!(batch.rows[1][1], "José");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reopen_as_accepts_whatwg_labels() {
        let path = std::env::temp_dir().join("clear_rows_doc_override.csv");
        // Valid UTF-8 bytes that a user insists are windows-1252: the override must win.
        std::fs::write(&path, b"id,name\n1,plain\n").unwrap();
        let options = OpenOptions { delimiter_override: None, encoding_override: Some("windows-1252".to_owned()) };
        let doc = CsvDocument::open_progressive_with_options(&path, 16, options).unwrap();
        assert_eq!(doc.summarize().profile.encoding, "windows-1252");
        assert_eq!(doc.summarize().profile.encoding_source, "user");

        let _ = std::fs::remove_file(path);
    }
}

/// Fixture audit: `CLEAR_ROWS_FIXTURES=<dir> cargo test fixture_audit -- --ignored --nocapture`
/// Prints how every file in the directory profiles, opens and searches. Not a pass/fail test.
#[cfg(test)]
mod fixture_audit {
    use super::*;
    use std::sync::{atomic::AtomicU64, Arc};

    #[test]
    #[ignore]
    fn fixture_audit() {
        let Ok(dir) = std::env::var("CLEAR_ROWS_FIXTURES") else { return };
        let mut entries: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            println!("\n=== {name}");
            match profile_csv_path(&path) {
                Ok(p) => println!(
                    "  profile: enc={} kind={} delim={:?} conf={} cols={} rows={} binary={} warnings={:?}",
                    p.profile.encoding, p.profile.detected_kind,
                    p.profile.delimiter_label, p.profile.delimiter_confidence,
                    p.profile.likely_columns, p.profile.sampled_rows, p.profile.binary_like,
                    p.profile.warnings
                ),
                Err(e) => println!("  profile: ERROR {e}"),
            }
            match CsvDocument::open_progressive_with_options(&path, 64, OpenOptions::default()) {
                Ok(mut doc) => {
                    let idx = doc.index_to_completion().map(|_| "ok".to_owned()).unwrap_or_else(|e| format!("ERROR {e}"));
                    let s = doc.summarize();
                    println!("  open: headers={:?} rows={} index={idx}", s.headers, doc.data_row_count());
                    match doc.get_rows(0, 2, 0, 16) {
                        Ok(batch) => println!("  rows: {}", serde_json::to_string(&batch).unwrap_or_default().chars().take(400).collect::<String>()),
                        Err(e) => println!("  rows: ERROR {e}"),
                    }
                }
                Err(e) => println!("  open: ERROR {e}"),
            }
            let needle = match name.as_str() {
                n if n.starts_with("cp1251") => "Иван",
                n if n.starts_with("shiftjis") => "山田",
                n if n.starts_with("timestamps") => "WS-0001",
                n if n.starts_with("utf") || n.starts_with("cp1252") || n.starts_with("latin") || n.starts_with("mac") => "Müller",
                _ => "2",
            };
            let summary = search_csv_files_with_progress(
                vec![path.to_string_lossy().into_owned()], needle.to_owned(), 10, 1, Arc::new(AtomicU64::new(1)), |_| {},
            );
            println!(
                "  search '{needle}': matches={} errors={:?} first={}",
                summary.matches.len(),
                summary.errors.iter().map(|e| serde_json::to_string(e).unwrap_or_default()).collect::<Vec<_>>(),
                summary.matches.first().map(|m| serde_json::to_string(m).unwrap_or_default().chars().take(200).collect::<String>()).unwrap_or_default()
            );
        }
    }
}
