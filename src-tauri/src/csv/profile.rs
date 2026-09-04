use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use chardetng::EncodingDetector;
use encoding_rs::{UTF_16BE, UTF_16LE, UTF_8};

use super::delimiter::{detect_delimiter, DelimiterConfidence};

pub const PROFILE_SAMPLE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    /// Any other charset encoding_rs knows (windows-1252, shift_jis, ...).
    /// Read through a transcoded UTF-8 cache, like UTF-16.
    Legacy(&'static encoding_rs::Encoding),
}

impl Encoding {
    /// The encoding_rs charset used to transcode this source to UTF-8.
    pub(crate) fn charset(self) -> &'static encoding_rs::Encoding {
        match self {
            Encoding::Utf8 | Encoding::Utf8Bom => UTF_8,
            Encoding::Utf16Le => UTF_16LE,
            Encoding::Utf16Be => UTF_16BE,
            Encoding::Legacy(charset) => charset,
        }
    }

    /// True when the bytes can be parsed directly; false when a transcode pass is needed.
    pub(crate) fn is_native_utf8(self) -> bool {
        matches!(self, Encoding::Utf8 | Encoding::Utf8Bom)
    }

    /// Stable label shown in the UI and accepted back by `Reopen as`.
    pub(crate) fn label(self) -> String {
        match self {
            Encoding::Utf8 => "utf-8".to_owned(),
            Encoding::Utf8Bom => "utf-8-bom".to_owned(),
            Encoding::Utf16Le => "utf-16-le".to_owned(),
            Encoding::Utf16Be => "utf-16-be".to_owned(),
            Encoding::Legacy(charset) => charset.name().to_ascii_lowercase(),
        }
    }

    /// Resolve a user-facing label (our four fixed ones or any WHATWG label).
    pub(crate) fn from_label(label: &str) -> Option<Self> {
        match label.trim().to_ascii_lowercase().as_str() {
            "utf-8" | "utf8" => Some(Encoding::Utf8),
            "utf-8-bom" | "utf8-bom" => Some(Encoding::Utf8Bom),
            "utf-16-le" | "utf-16le" | "utf16le" => Some(Encoding::Utf16Le),
            "utf-16-be" | "utf-16be" | "utf16be" => Some(Encoding::Utf16Be),
            other => {
                let charset = encoding_rs::Encoding::for_label(other.as_bytes())?;
                if charset == UTF_8 {
                    Some(Encoding::Utf8)
                } else if charset == UTF_16LE {
                    Some(Encoding::Utf16Le)
                } else if charset == UTF_16BE {
                    Some(Encoding::Utf16Be)
                } else {
                    Some(Encoding::Legacy(charset))
                }
            }
        }
    }
}

/// How the encoding was decided; surfaced so the UI can say "detected" vs "from BOM".
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum EncodingSource {
    Bom,
    ValidUtf8,
    Heuristic,
    User,
}

impl EncodingSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            EncodingSource::Bom => "bom",
            EncodingSource::ValidUtf8 => "utf-8",
            EncodingSource::Heuristic => "detected",
            EncodingSource::User => "user",
        }
    }
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
    /// "bom", "utf-8", "detected" or "user".
    pub encoding_source: String,
    pub sampled_rows: usize,
    pub likely_columns: usize,
    pub binary_like: bool,
    /// False when the first row is data and columns carry generated names.
    pub has_header: bool,
    /// "detected" or "user".
    pub header_source: String,
    /// "gzip" when the file was decompressed before reading, else None.
    pub compression: Option<String>,
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
    let (encoding, data_start, encoding_source) = detect_encoding(&mut file)?;

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
    // Only native UTF-8 sources can have invalid bytes we decode lossily; every
    // other encoding goes through a real transcode.
    let valid_utf8 = match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => std::str::from_utf8(&sample_buf).is_ok(),
        _ => true,
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
            encoding: if valid_utf8 { encoding.label() } else { "utf-8-lossy".to_owned() },
            encoding_source: encoding_source.as_str().to_owned(),
            sampled_rows: detection.sampled_rows,
            likely_columns: detection.likely_columns,
            binary_like,
            has_header: true,
            header_source: "detected".to_owned(),
            compression: None,
            warnings,
        },
        delimiter: detection.delimiter,
        data_start,
        encoding,
    })
}

/// Decide the source encoding: BOM first, then "is it valid UTF-8", then a
/// BOM-less UTF-16 check (every other byte is NUL for Latin text), then
/// chardetng for the legacy single- and multi-byte codepages Windows tools
/// still emit (windows-1252 from Excel, shift_jis, windows-1251, ...).
fn detect_encoding(file: &mut File) -> std::io::Result<(Encoding, u64, EncodingSource)> {
    file.seek(SeekFrom::Start(0))?;

    let mut prefix = [0u8; 3];
    let n = file.read(&mut prefix)?;

    if n >= 3 && prefix == [0xEF, 0xBB, 0xBF] {
        return Ok((Encoding::Utf8Bom, 3, EncodingSource::Bom));
    }
    if n >= 2 && prefix[0] == 0xFF && prefix[1] == 0xFE {
        return Ok((Encoding::Utf16Le, 2, EncodingSource::Bom));
    }
    if n >= 2 && prefix[0] == 0xFE && prefix[1] == 0xFF {
        return Ok((Encoding::Utf16Be, 2, EncodingSource::Bom));
    }

    file.seek(SeekFrom::Start(0))?;
    let mut sample = vec![0u8; PROFILE_SAMPLE_BYTES];
    let read = file.read(&mut sample)?;
    sample.truncate(read);
    file.seek(SeekFrom::Start(0))?;

    // UTF-16 first: ASCII text in UTF-16 is byte-for-byte valid UTF-8 (letters
    // interleaved with NUL), so the UTF-8 check alone would accept it and the
    // parser would then see NULs in every field.
    if let Some(encoding) = sniff_bomless_utf16(&sample) {
        return Ok((encoding, 0, EncodingSource::Heuristic));
    }

    if sample.is_empty() || std::str::from_utf8(&sample).is_ok() || utf8_valid_except_tail(&sample) {
        return Ok((Encoding::Utf8, 0, EncodingSource::ValidUtf8));
    }

    let mut detector = EncodingDetector::new();
    detector.feed(&sample, read < PROFILE_SAMPLE_BYTES);
    let charset = detector.guess(None, true);
    if charset == UTF_8 {
        // chardetng only says UTF-8 for valid UTF-8, which we excluded above;
        // treat anything else as windows-1252, the overwhelmingly common case.
        return Ok((Encoding::Legacy(encoding_rs::WINDOWS_1252), 0, EncodingSource::Heuristic));
    }
    Ok((Encoding::Legacy(charset), 0, EncodingSource::Heuristic))
}

/// A sample cut mid-character is still UTF-8. Accept when the only invalid
/// bytes are an incomplete sequence at the very end.
fn utf8_valid_except_tail(sample: &[u8]) -> bool {
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(err) => err.error_len().is_none() && err.valid_up_to() + 4 > sample.len(),
    }
}

/// UTF-16 without a BOM: for Latin-script text, one byte of nearly every pair
/// is NUL. Decide endianness by which position holds the zeros.
fn sniff_bomless_utf16(sample: &[u8]) -> Option<Encoding> {
    if sample.len() < 16 {
        return None;
    }
    let pairs = sample.len() / 2;
    let (mut even_zero, mut odd_zero) = (0usize, 0usize);
    for pair in sample.chunks_exact(2) {
        if pair[0] == 0 {
            even_zero += 1;
        }
        if pair[1] == 0 {
            odd_zero += 1;
        }
    }
    let threshold = pairs * 3 / 10; // ≥30% of code units have a NUL high byte
    if odd_zero >= threshold && odd_zero > even_zero * 4 {
        return Some(Encoding::Utf16Le);
    }
    if even_zero >= threshold && even_zero > odd_zero * 4 {
        return Some(Encoding::Utf16Be);
    }
    None
}

fn decode_sample_to_utf8(sample: &[u8], encoding: Encoding) -> Cow<'_, [u8]> {
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => Cow::Borrowed(sample),
        Encoding::Utf16Le => Cow::Owned(decode_utf16(sample, u16::from_le_bytes)),
        Encoding::Utf16Be => Cow::Owned(decode_utf16(sample, u16::from_be_bytes)),
        Encoding::Legacy(charset) => {
            let (decoded, _, _) = charset.decode(sample);
            Cow::Owned(decoded.into_owned().into_bytes())
        }
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
    fn detects_windows_1252_and_decodes_sample() {
        let path = std::env::temp_dir().join("clear_rows_profile_cp1252.csv");
        // "id,name\n1,Zoë Müller\n2,José\n" in windows-1252 (ë=0xEB ü=0xFC é=0xE9)
        let mut bytes = b"id,name\n1,Zo\xEB M\xFCller\n2,Jos\xE9\n".to_vec();
        bytes.extend_from_slice(b"3,caf\xE9 na\xEFve\n");
        fs::write(&path, &bytes).expect("write cp1252 fixture");

        let profiled = profile_csv_path(&path).expect("profile cp1252 csv");

        assert_eq!(profiled.profile.encoding, "windows-1252");
        assert_eq!(profiled.profile.encoding_source, "detected");
        assert_eq!(profiled.delimiter, b',');
        assert!(!profiled.profile.binary_like);
        assert!(profiled.profile.warnings.is_empty(), "{:?}", profiled.profile.warnings);
        assert!(matches!(profiled.encoding, Encoding::Legacy(_)));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_bomless_utf16_le() {
        let path = std::env::temp_dir().join("clear_rows_profile_utf16_nobom.csv");
        let text = "id,name,city\n1,Alpha,Cape Town\n2,Beta,Durban\n3,Gamma,Pretoria\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        fs::write(&path, &bytes).expect("write bom-less utf-16 fixture");

        let profiled = profile_csv_path(&path).expect("profile bom-less utf-16");

        assert_eq!(profiled.profile.encoding, "utf-16-le");
        assert_eq!(profiled.profile.encoding_source, "detected");
        assert_eq!(profiled.data_start, 0);
        assert!(!profiled.profile.binary_like, "must not be rejected as binary");
        assert_eq!(profiled.profile.likely_columns, 3);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_shift_jis() {
        let path = std::env::temp_dir().join("clear_rows_profile_sjis.csv");
        // "id,名前\n1,山田太郎\n2,佐藤花子\n" in Shift_JIS
        let bytes = b"id,\x96\xBC\x91\x4F\n1,\x8E\x52\x93\x63\x91\xBE\x98\x59\n2,\x8D\xB2\x93\xA1\x89\xD4\x8Eq\n";
        fs::write(&path, bytes).expect("write shift_jis fixture");

        let profiled = profile_csv_path(&path).expect("profile shift_jis");

        assert_eq!(profiled.profile.encoding, "shift_jis");
        assert_eq!(profiled.delimiter, b',');

        let _ = fs::remove_file(path);
    }

    #[test]
    fn resolves_encoding_labels() {
        assert!(matches!(Encoding::from_label("utf-8"), Some(Encoding::Utf8)));
        assert!(matches!(Encoding::from_label("UTF-8-BOM"), Some(Encoding::Utf8Bom)));
        assert!(matches!(Encoding::from_label("utf-16-le"), Some(Encoding::Utf16Le)));
        assert!(matches!(Encoding::from_label("utf-16le"), Some(Encoding::Utf16Le)));
        assert_eq!(
            Encoding::from_label("windows-1252").map(|e| e.label()),
            Some("windows-1252".to_owned())
        );
        assert_eq!(
            Encoding::from_label("latin1").map(|e| e.label()),
            Some("windows-1252".to_owned()),
            "WHATWG maps latin1 onto windows-1252"
        );
        assert_eq!(Encoding::from_label("macintosh").map(|e| e.label()), Some("macintosh".to_owned()));
        assert!(Encoding::from_label("not-an-encoding").is_none());
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
