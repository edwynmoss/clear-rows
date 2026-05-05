use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use super::delimiter::{detect_delimiter, DelimiterConfidence};

pub const PROFILE_SAMPLE_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize)]
pub struct CsvFileProfile {
    pub extension: Option<String>,
    pub detected_kind: String,
    pub detected_kind_label: String,
    pub delimiter: Option<u8>,
    pub delimiter_label: Option<String>,
    pub delimiter_confidence: String,
    pub encoding: String,
    pub sampled_rows: usize,
    pub likely_columns: usize,
    pub binary_like: bool,
    pub warnings: Vec<String>,
}

pub struct ProfiledCsvFile {
    pub profile: CsvFileProfile,
    pub delimiter: u8,
    pub data_start: u64,
}

pub fn profile_csv_path(path: &Path) -> std::io::Result<ProfiledCsvFile> {
    let mut file = File::open(path)?;
    let data_start = skip_utf8_bom(&mut file)?;

    let mut sample_buf = vec![0u8; PROFILE_SAMPLE_BYTES];
    file.seek(SeekFrom::Start(data_start))?;
    let sample_read = file.read(&mut sample_buf)?;
    sample_buf.truncate(sample_read);

    let detection = detect_delimiter(&sample_buf);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    let binary_like = is_binary_like(&sample_buf);
    let has_bom = data_start > 0;
    let valid_utf8 = std::str::from_utf8(&sample_buf).is_ok();
    let has_delimited_shape = detection.multi_column_rows > 0 && detection.likely_columns >= 2;
    let detected_kind = classify_kind(
        extension.as_deref(),
        detection.delimiter,
        has_delimited_shape,
    );
    let delimiter = has_delimited_shape.then_some(detection.delimiter);

    let mut warnings = Vec::new();
    if binary_like {
        warnings.push("Binary-looking content detected.".to_owned());
    }
    if !valid_utf8 {
        warnings.push("Invalid UTF-8 bytes detected; text may be decoded lossily.".to_owned());
    }
    if !has_delimited_shape {
        warnings.push("No consistent delimiter found in the sample.".to_owned());
    }
    if detection.confidence == DelimiterConfidence::Low && has_delimited_shape {
        warnings.push("Delimiter confidence is low.".to_owned());
    }
    if let Some(warning) = extension_delimiter_warning(extension.as_deref(), detection.delimiter) {
        warnings.push(warning);
    }

    Ok(ProfiledCsvFile {
        profile: CsvFileProfile {
            extension,
            detected_kind_label: kind_label(detected_kind).to_owned(),
            detected_kind: detected_kind.to_owned(),
            delimiter,
            delimiter_label: delimiter.map(delimiter_label).map(str::to_owned),
            delimiter_confidence: detection.confidence.as_str().to_owned(),
            encoding: if has_bom {
                "utf-8-bom".to_owned()
            } else if valid_utf8 {
                "utf-8".to_owned()
            } else {
                "utf-8-lossy".to_owned()
            },
            sampled_rows: detection.sampled_rows,
            likely_columns: detection.likely_columns,
            binary_like,
            warnings,
        },
        delimiter: detection.delimiter,
        data_start,
    })
}

pub fn skip_utf8_bom(file: &mut File) -> std::io::Result<u64> {
    file.seek(SeekFrom::Start(0))?;

    let mut prefix = [0u8; 3];
    let n = file.read(&mut prefix)?;
    if n == 3 && prefix == [0xEF, 0xBB, 0xBF] {
        return Ok(3);
    }

    file.seek(SeekFrom::Start(0))?;
    Ok(0)
}

fn classify_kind(
    extension: Option<&str>,
    delimiter: u8,
    has_delimited_shape: bool,
) -> &'static str {
    match extension {
        Some("csv") => "csv",
        Some("tsv") => "tsv",
        Some("txt") if has_delimited_shape => "delimited_text",
        Some("txt") => "plain_text",
        _ if has_delimited_shape && delimiter == b'\t' => "tsv",
        _ if has_delimited_shape => "delimited_text",
        _ => "plain_text",
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "csv" => "CSV",
        "tsv" => "TSV",
        "delimited_text" => "Delimited text",
        "plain_text" => "Plain text",
        _ => "Text",
    }
}

fn delimiter_label(delimiter: u8) -> &'static str {
    match delimiter {
        b',' => "comma",
        b';' => "semicolon",
        b'\t' => "tab",
        b'|' => "pipe",
        _ => "unknown",
    }
}

fn extension_delimiter_warning(extension: Option<&str>, delimiter: u8) -> Option<String> {
    match (extension, delimiter) {
        (Some("tsv"), b'\t')
        | (Some("csv"), b',')
        | (Some("csv"), b';')
        | (Some("txt"), _)
        | (None, _) => None,
        (Some("tsv"), _) => Some(format!(
            "Extension is TSV but detected {} delimiter.",
            delimiter_label(delimiter)
        )),
        (Some("csv"), _) => Some(format!(
            "Extension is CSV but detected {} delimiter.",
            delimiter_label(delimiter)
        )),
        _ => None,
    }
}

fn is_binary_like(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }

    if sample.contains(&0) {
        return true;
    }

    let control_count = sample
        .iter()
        .filter(|&&byte| byte < 0x20 && !matches!(byte, b'\n' | b'\r' | b'\t'))
        .count();
    let control_ratio = control_count as f64 / sample.len() as f64;

    control_ratio > 0.05
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn profiles_semicolon_csv() {
        let path = std::env::temp_dir().join("dataparser_profile_semicolon.csv");
        fs::write(&path, "id;name\n1;Alpha\n2;Beta\n").expect("write fixture");

        let profiled = profile_csv_path(&path).expect("profile csv");

        assert_eq!(profiled.delimiter, b';');
        assert_eq!(profiled.profile.detected_kind, "csv");
        assert_eq!(
            profiled.profile.delimiter_label.as_deref(),
            Some("semicolon")
        );
        assert_eq!(profiled.profile.delimiter_confidence, "high");
        assert!(!profiled.profile.binary_like);
        assert!(profiled.profile.warnings.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn flags_binary_looking_files() {
        let path = std::env::temp_dir().join("dataparser_profile_binary.txt");
        fs::write(&path, [0, 159, 146, 150, 0, 1, 2, 3]).expect("write fixture");

        let profiled = profile_csv_path(&path).expect("profile binary-ish file");

        assert!(profiled.profile.binary_like);
        assert!(profiled
            .profile
            .warnings
            .iter()
            .any(|warning| warning.contains("Binary-looking")));

        let _ = fs::remove_file(path);
    }
}
