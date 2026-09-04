mod delimiter;
mod document;
mod export;
mod filter;
mod parser;
mod profile;
pub mod header;
pub mod scan;
pub mod stats;
pub mod types;
mod search;
mod sort;

pub use document::{CsvDocument, CsvError, IndexStatus, OpenOptions, OpenSummary, RowBatch};
pub use export::{build_export, ExportBuildOptions, ExportState, ExportStatus};
pub use stats::{compute_column_stats, ColumnStats, ColumnStatsOptions};
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
        let options = OpenOptions { delimiter_override: None, encoding_override: Some("windows-1252".to_owned()), header_override: None };
        let doc = CsvDocument::open_progressive_with_options(&path, 16, options).unwrap();
        assert_eq!(doc.summarize().profile.encoding, "windows-1252");
        assert_eq!(doc.summarize().profile.encoding_source, "user");

        let _ = std::fs::remove_file(path);
    }
}

/// Performance harness on a large file. Run in release:
/// `CLEAR_ROWS_BIG=<csv> cargo test --release perf_timing -- --ignored --nocapture`
#[cfg(test)]
mod perf_timing {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::{atomic::AtomicU64, Arc};
    use std::time::Instant;

    fn ms(started: Instant) -> String {
        format!("{:>8.0} ms", started.elapsed().as_secs_f64() * 1000.0)
    }

    #[test]
    #[ignore]
    fn perf_timing() {
        let Ok(path) = std::env::var("CLEAR_ROWS_BIG") else { return };
        let path = std::path::PathBuf::from(path);
        let size_mb = path.metadata().map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);
        println!("\nfile: {} ({size_mb:.0} MB)", path.display());

        // Open: first rows available, then background indexing to completion.
        let started = Instant::now();
        let mut doc = CsvDocument::open_progressive_with_options(&path, 2_048, OpenOptions::default()).unwrap();
        println!("{:<44}{}   ({} rows visible)", "open (first 2,048 rows)", ms(started), doc.data_row_count());
        let started = Instant::now();
        while !doc.index_next_chunk(4_096).unwrap() {}
        let rows = doc.data_row_count();
        println!("{:<44}{}   ({} rows)", "index to completion", ms(started), rows);

        // Random access in natural order (what scrolling does).
        let started = Instant::now();
        for i in 0..200u64 {
            let start = (i * 7919 * 13) % rows.max(1);
            doc.get_rows(start, 64, 0, 9).unwrap();
        }
        println!("{:<44}{}   (200 windows of 64 rows)", "random window reads", ms(started));

        let headers = doc.summarize().headers;
        let read_path = doc.read_path().to_path_buf();
        let data_start = doc.read_data_start();
        let delimiter = doc.delimiter();

        // Filters.
        let mut masks = Vec::new();
        for query in ["powershell", "process:powershell command_line:-enc", "hostname:/^WS-00[0-4]/ -severity=low", "severity=critical"] {
            let state = Arc::new(Mutex::new(FilterState::idle()));
            let started = Instant::now();
            let built = build_filter(FilterBuildOptions {
                source_path: read_path.clone(),
                data_start,
                delimiter,
                headers: headers.clone(),
                blocks: Some(doc.block_index()),
                query: query.to_owned(),
                total_rows: rows,
                generation: 1,
                generation_state: Arc::new(AtomicU64::new(1)),
                state: Arc::clone(&state),
            });
            if let Err(err) = built {
                // Real-world files rarely have the synthetic column names.
                println!("{:<44}skipped ({err})", format!("filter  {query}"));
                continue;
            }
            let matched = state.lock().mask.as_ref().map(|m| m.len()).unwrap_or(0);
            println!("{:<44}{}   ({} rows match)", format!("filter  {query}"), ms(started), matched);
            masks.push(state.lock().mask.as_ref().map(|m| (**m).clone()).unwrap_or_default());
        }

        // Sort by one text column, then by two.
        let last = headers.len().saturating_sub(1);
        for keys in [vec![SortKey { column: 1.min(last), direction: sort::SortDirection::Asc }], vec![SortKey { column: 7.min(last), direction: sort::SortDirection::Desc }, SortKey { column: 0, direction: sort::SortDirection::Asc }]] {
            let state = Arc::new(Mutex::new(SortState::idle()));
            let spill_dir = std::env::temp_dir().join(format!("clear-rows-perf-sort-{}", std::process::id()));
            let label = format!("sort by {} key{}", keys.len(), if keys.len() == 1 { "" } else { "s" });
            let started = Instant::now();
            build_sort(SortBuildOptions {
                source_path: read_path.clone(),
                data_start,
                delimiter,
                keys,
                blocks: Some(doc.block_index()),
                spill_dir,
                generation: 1,
                generation_state: Arc::new(AtomicU64::new(1)),
                state: Arc::clone(&state),
            })
            .unwrap();
            println!("{:<44}{}", label, ms(started));
        }

        // Filtered-view scrolling: window reads through a mask (ascending).
        let mask = masks.last().cloned().unwrap_or_default();
        let started = Instant::now();
        for i in 0..200usize {
            let start = (i * 997) % mask.len().max(1);
            let slice: Vec<u64> = mask.iter().skip(start).take(64).copied().collect();
            doc.get_rows_at_physical_data_indices(start as u64, &slice, 0, 9).unwrap();
        }
        println!("{:<44}{}   (200 windows through a {}-row mask)", "filtered window reads", ms(started), mask.len());

        // Export the filtered view.
        let target = std::env::temp_dir().join("clear-rows-perf-export.csv");
        let export_state = Arc::new(Mutex::new(ExportState::idle()));
        let started = Instant::now();
        let written = build_export(ExportBuildOptions {
            target_path: target.clone(),
            headers: headers.clone(),
            delimiter,
            visible_indices: mask.clone(),
            generation: 1,
            generation_state: Arc::new(AtomicU64::new(1)),
            state: export_state,
            fetch_chunk: {
                // Same strategy as the export command: one parallel offset sweep, then direct reads.
                let map = scan::FileMap::open(&read_path).unwrap();
                let mut wanted = mask.clone();
                wanted.sort_unstable();
                let offsets = scan::row_offsets(map.bytes(), &doc.block_index(), delimiter, &wanted);
                move |_visible_start: u64, indices: &[u64]| {
                    let bytes = map.bytes();
                    let mut out = Vec::with_capacity(indices.len());
                    let mut fields = Vec::new();
                    let mut scratch = Vec::new();
                    for &phys in indices {
                        let offset = wanted.binary_search(&phys).ok().map(|i| offsets[i]).unwrap_or(bytes.len());
                        let mut scanner = scan::RowScanner::new(bytes, offset, delimiter);
                        let mut row = Vec::with_capacity(9);
                        if scanner.next_row(&mut fields) {
                            for f in &fields {
                                row.push(scan::field_string(bytes, f, &mut scratch));
                            }
                        }
                        out.push(row);
                    }
                    Ok(out)
                }
            },
        })
        .unwrap();
        println!("{:<44}{}   ({} rows written)", "export filtered view", ms(started), written);
        let _ = std::fs::remove_file(target);

        // Multi-file search of the same file (worst case: whole file scanned).
        let started = Instant::now();
        let summary = search_csv_files_with_progress(vec![path.to_string_lossy().into_owned()], "0badf00d".to_owned(), 500, 1, Arc::new(AtomicU64::new(1)), |_| {});
        println!("{:<44}{}   ({} matches)", "search across files (1 file)", ms(started), summary.matches.len());
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
