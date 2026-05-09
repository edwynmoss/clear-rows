use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use super::delimiter::{detect_delimiter, DelimiterConfidence};

pub const PROFILE_SAMPLE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

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
    pub(crate) encoding: Encoding,
}

pub fn profile_csv_path(path: &Path) -> std::io::Result<ProfiledCsvFile> {
    let mut file = File::open(path)?;
    let (encoding, data_start) = detect_encoding(&mut file)?;

    let mut sample_buf = vec![0u8; PROFILE_SAMPLE_BYTES];
    file.seek(SeekFrom::Start(data_start))?;
    let sample_read = file.read(&mut sample_buf)?;
    sample_buf.truncate(sample_read);

    // Run delimiter detection and binary heuristics on a UTF-8 view of the
    // sample so UTF-16 inputs aren't dismissed as binary (every other byte is
    // 0x00 for ASCII text) and so the delimiter scorer sees real characters.
    let decoded_sample = decode_sample_to_utf8(&sample_buf, encoding);

    let detection = detect_delimiter(&decoded_sample);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    let binary_like = is_binary_like(&decoded_sample);
    let valid_utf8 = match encoding {
        Encoding::Utf16Le | Encoding::Utf16Be => true,
        _ => std::str::from_utf8(&sample_buf).is_ok(),
    };
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
            encoding: encoding_label(encoding, valid_utf8).to_owned(),
            sampled_rows: detection.sampled_rows,
            likely_columns: detection.likely_columns,
            binary_like,
            warnings,
        },
        delimiter: detection.delimiter,
        data_start,
        encoding,
    })
}

fn detect_encoding(file: &mut File) -> std::io::Result<(Encoding, u64)> {
    file.seek(SeekFrom::Start(0))?;

    let mut prefix = [0u8; 3];
    let n = file.read(&mut prefix)?;

    if n >= 3 && prefix == [0xEF, 0xBB, 0xBF] {
        return Ok((Encoding::Utf8Bom, 3));
    }
    if n >= 2 && prefix[0] == 0xFF && prefix[1] == 0xFE {
        return Ok((Encoding::Utf16Le, 2));
    }
    if n >= 2 && prefix[0] == 0xFE && prefix[1] == 0xFF {
        return Ok((Encoding::Utf16Be, 2));
    }

    file.seek(SeekFrom::Start(0))?;
    Ok((Encoding::Utf8, 0))
}

fn decode_sample_to_utf8(sample: &[u8], encoding: Encoding) -> Cow<'_, [u8]> {
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => Cow::Borrowed(sample),
        Encoding::Utf16Le => Cow::Owned(decode_utf16(sample, u16::from_le_bytes)),
        Encoding::Utf16Be => Cow::Owned(decode_utf16(sample, u16::from_be_bytes)),
    }
}

fn decode_utf16(sample: &[u8], to_unit: fn([u8; 2]) -> u16) -> Vec<u8> {
    // chunks_exact silently drops a trailing odd byte, which is the right
    // behavior at sample boundaries (we may have sliced inside a code unit).
    let units: Vec<u16> = sample
        .chunks_exact(2)
        .map(|pair| to_unit([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units).into_bytes()
}

fn encoding_label(encoding: Encoding, valid_utf8: bool) -> &'static str {
    match encoding {
        Encoding::Utf8 if !valid_utf8 => "utf-8-lossy",
        Encoding::Utf8 => "utf-8",
        Encoding::Utf8Bom => "utf-8-bom",
        Encoding::Utf16Le => "utf-16-le",
        Encoding::Utf16Be => "utf-16-be",
    }
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

pub(crate) fn delimiter_label(delimiter: u8) -> &'static str {
    match delimiter {
        b',' => "comma",
        b';' => "semicolon",
        b'\t' => "tab",
        b'|' => "pipe",
        b':' => "colon",
        b' ' => "space",
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

    fn encode_utf16_with_bom<F: Fn(u16) -> [u8; 2]>(text: &str, bom: [u8; 2], to_bytes: F) -> Vec<u8> {
        let mut bytes = bom.to_vec();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&to_bytes(unit));
        }
        bytes
    }

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

    #[test]
    fn profiles_utf16_le_comma_csv() {
        let path = std::env::temp_dir().join("dataparser_profile_utf16_le.csv");
        let bytes = encode_utf16_with_bom(
            "id,name,city\n1,Alpha,Cape Town\n2,Beta,Durban\n3,Gamma,Pretoria\n",
            [0xFF, 0xFE],
            |unit| unit.to_le_bytes(),
        );
        fs::write(&path, &bytes).expect("write utf-16-le fixture");

        let profiled = profile_csv_path(&path).expect("profile utf-16-le csv");

        assert_eq!(profiled.delimiter, b',');
        assert_eq!(profiled.data_start, 2);
        assert_eq!(profiled.profile.detected_kind, "csv");
        assert_eq!(profiled.profile.delimiter_label.as_deref(), Some("comma"));
        assert_eq!(profiled.profile.encoding, "utf-16-le");
        assert!(!profiled.profile.binary_like);
        assert!(profiled
            .profile
            .warnings
            .iter()
            .all(|warning| !warning.contains("Binary-looking")
                && !warning.contains("Invalid UTF-8")));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn profiles_utf16_be_comma_csv() {
        let path = std::env::temp_dir().join("dataparser_profile_utf16_be.csv");
        let bytes = encode_utf16_with_bom(
            "id,name,city\n1,Alpha,Cape Town\n2,Beta,Durban\n3,Gamma,Pretoria\n",
            [0xFE, 0xFF],
            |unit| unit.to_be_bytes(),
        );
        fs::write(&path, &bytes).expect("write utf-16-be fixture");

        let profiled = profile_csv_path(&path).expect("profile utf-16-be csv");

        assert_eq!(profiled.delimiter, b',');
        assert_eq!(profiled.data_start, 2);
        assert_eq!(profiled.profile.detected_kind, "csv");
        assert_eq!(profiled.profile.delimiter_label.as_deref(), Some("comma"));
        assert_eq!(profiled.profile.encoding, "utf-16-be");
        assert!(!profiled.profile.binary_like);

        let _ = fs::remove_file(path);
    }
}
