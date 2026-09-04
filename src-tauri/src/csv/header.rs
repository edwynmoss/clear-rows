//! Decide whether the first row of a file is a header row or already data.
//!
//! Real exports frequently arrive without a header (regulator dumps, syslog
//! reports, anything cut out of a bigger file). Treating the first record as
//! column names then puts a person's details in the header bar, so the open
//! path samples the first rows and votes. The user can override either way.

/// How the first row should be treated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderMode {
    /// Decide from the first rows.
    Auto,
    /// The first row holds column names.
    Present,
    /// The first row is data; columns get generated names.
    Absent,
}

impl HeaderMode {
    /// Labels the UI sends: "auto", "header", "data". Unknown labels mean auto.
    pub fn from_label(label: Option<&str>) -> Self {
        match label.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("header") | Some("present") | Some("true") => HeaderMode::Present,
            Some("data") | Some("absent") | Some("none") | Some("false") => HeaderMode::Absent,
            _ => HeaderMode::Auto,
        }
    }
}

/// Generated column names for a file without a header row.
pub fn synthetic_headers(count: usize) -> Vec<String> {
    (1..=count).map(|n| format!("Column {n}")).collect()
}

/// True when `rows[0]` looks like a header for the rows that follow.
///
/// Each column casts votes: a numeric, empty, date-like or e-mail-like first
/// cell says "data"; a text cell above a numeric or fixed-width column says
/// "header"; repeated values in the first row say "data". Ties keep the
/// header, which is what every CSV tool assumes by default.
pub fn detect_header(rows: &[Vec<String>]) -> bool {
    let Some(first) = rows.first() else {
        return true;
    };
    let sample = &rows[1..];
    if sample.is_empty() {
        return true;
    }

    let mut header_votes = 0i32;
    let mut data_votes = 0i32;

    for (column, cell) in first.iter().enumerate() {
        let cell = cell.trim();
        let column_cells: Vec<&str> = sample
            .iter()
            .filter_map(|row| row.get(column))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect();

        if cell.is_empty() {
            if !column_cells.is_empty() {
                data_votes += 1;
            }
            continue;
        }
        if is_numeric(cell) || is_date_like(cell) || is_email_like(cell) {
            data_votes += 2;
            continue;
        }
        if column_cells.is_empty() {
            continue;
        }

        let numeric = column_cells.iter().filter(|value| is_numeric(value)).count();
        if numeric * 5 >= column_cells.len() * 4 {
            // Text above a numeric column is the classic header signature.
            header_votes += 2;
            continue;
        }

        let widths: Vec<usize> = column_cells.iter().map(|value| value.chars().count()).collect();
        let fixed_width = widths.len() >= 3 && widths.iter().all(|w| *w == widths[0]);
        if fixed_width {
            if cell.chars().count() == widths[0] {
                data_votes += 1;
            } else {
                header_votes += 1;
            }
        }
    }

    // Column names repeat far less often than data values do.
    let mut seen = std::collections::HashSet::new();
    let duplicated = first
        .iter()
        .map(|cell| cell.trim().to_ascii_lowercase())
        .filter(|cell| !cell.is_empty())
        .any(|cell| !seen.insert(cell));
    if duplicated {
        data_votes += 2;
    }

    header_votes >= data_votes
}

fn is_numeric(value: &str) -> bool {
    let cleaned: String = value
        .chars()
        .filter(|c| !matches!(c, ' ' | ',' | '_' | '\u{a0}'))
        .collect();
    if cleaned.is_empty() {
        return false;
    }
    let body = cleaned.strip_prefix(['+', '-']).unwrap_or(&cleaned);
    if body.is_empty() {
        return false;
    }
    body.chars().all(|c| c.is_ascii_digit() || c == '.')
        && body.chars().any(|c| c.is_ascii_digit())
        && body.matches('.').count() <= 1
}

fn is_date_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    // 2024-01-31, 2024/01/31, 31/01/2024, 31-01-2024, optionally followed by a time.
    let digits_at = |range: std::ops::Range<usize>| bytes.get(range).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    let sep_at = |i: usize| matches!(bytes.get(i), Some(b'-') | Some(b'/') | Some(b'.'));
    (digits_at(0..4) && sep_at(4) && digits_at(5..7) && sep_at(7) && digits_at(8..10))
        || (digits_at(0..2) && sep_at(2) && digits_at(3..5) && sep_at(5) && digits_at(6..10))
}

fn is_email_like(value: &str) -> bool {
    let Some(at) = value.find('@') else {
        return false;
    };
    at > 0 && value[at + 1..].contains('.') && !value.contains(' ')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(text: &str) -> Vec<Vec<String>> {
        text.lines()
            .map(|line| line.split(',').map(str::to_owned).collect())
            .collect()
    }

    #[test]
    fn text_over_numeric_columns_is_a_header() {
        assert!(detect_header(&rows("id,name,age\n1,Ann,34\n2,Bo,41\n3,Cy,29")));
    }

    #[test]
    fn regulator_dump_without_header_is_data() {
        let text = "1347445,MALOKANE CONSALIA,NAWE,FEMALE,Registered,PENDING RENEWAL,D,PENDING RENEWAL,\n\
                    1347446,SOMEONE ELSE,NAWE,MALE,Registered,ACTIVE,D,ACTIVE,\n\
                    1347447,THIRD PERSON,NAWE,FEMALE,Registered,ACTIVE,D,ACTIVE,";
        assert!(!detect_header(&rows(text)));
    }

    #[test]
    fn phone_and_name_rows_are_data() {
        assert!(!detect_header(&rows("27609897840,YOLANDA ZITO,ZA\n27609897841,ANOTHER NAME,ZA\n27609897842,THIRD NAME,ZA")));
    }

    #[test]
    fn dates_and_emails_in_the_first_row_are_data() {
        assert!(!detect_header(&rows("2024-01-31,a@b.co,x\n2024-02-01,c@d.co,y\n2024-02-02,e@f.co,z")));
    }

    #[test]
    fn all_text_files_keep_the_header_on_a_tie() {
        assert!(detect_header(&rows("name,city\nAnn,Cape Town\nBo,Durban")));
        assert!(detect_header(&rows("Ann,Cape Town\nBo,Durban")));
    }

    #[test]
    fn single_row_and_empty_input_default_to_header() {
        assert!(detect_header(&rows("id,name")));
        assert!(detect_header(&[]));
    }

    #[test]
    fn fixed_width_ids_under_a_longer_label_are_a_header() {
        assert!(detect_header(&rows("ID_Number,Surname\n8001015009087,Moss\n8001015009088,Zito\n8001015009089,Nawe")));
    }

    #[test]
    fn labels_map_to_modes() {
        assert_eq!(HeaderMode::from_label(Some("header")), HeaderMode::Present);
        assert_eq!(HeaderMode::from_label(Some("Data")), HeaderMode::Absent);
        assert_eq!(HeaderMode::from_label(Some("auto")), HeaderMode::Auto);
        assert_eq!(HeaderMode::from_label(None), HeaderMode::Auto);
        assert_eq!(synthetic_headers(3), ["Column 1", "Column 2", "Column 3"]);
    }
}
