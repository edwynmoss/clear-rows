//! Column typing shared by sorting, the header hints and the column panel.
//!
//! Cells are classified from their text alone: numbers with the separators
//! and currency marks real exports carry, dates in the handful of layouts
//! that cover almost everything (ISO, day/month/year, month names), and
//! text for the rest. A column takes the type of at least 80% of its
//! non-empty sample; anything else is text.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellKind {
    Empty,
    Integer,
    Decimal,
    Date,
    DateTime,
    Text,
}

/// Which way an ambiguous numeric date like 03/04/2026 reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DateOrder {
    DayFirst,
    MonthFirst,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    Text,
    Integer,
    Decimal,
    Date,
    DateTime,
    /// No non-empty sample values.
    Empty,
}

impl ColumnType {
    pub fn is_numeric(self) -> bool {
        matches!(self, ColumnType::Integer | ColumnType::Decimal)
    }

    pub fn is_temporal(self) -> bool {
        matches!(self, ColumnType::Date | ColumnType::DateTime)
    }
}

/// Result of sampling one column.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ColumnProfile {
    #[serde(rename = "type")]
    pub kind: ColumnType,
    pub date_order: DateOrder,
}

/// Share of non-empty samples that must agree before a column gets a type.
const TYPE_RATIO: f64 = 0.8;

/// Type a column from sampled cell texts.
pub fn detect_column_type<'a>(values: impl IntoIterator<Item = &'a str>) -> ColumnProfile {
    let mut non_empty = 0usize;
    let mut integers = 0usize;
    let mut decimals = 0usize;
    let mut dates = 0usize;
    let mut date_times = 0usize;
    let mut day_first_votes = 0usize;
    let mut month_first_votes = 0usize;

    for raw in values {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        non_empty += 1;
        match classify(value) {
            CellKind::Integer => integers += 1,
            CellKind::Decimal => decimals += 1,
            CellKind::Date | CellKind::DateTime => {
                if let Some((first, second)) = leading_numeric_pair(value) {
                    if first > 12 {
                        day_first_votes += 1;
                    } else if second > 12 {
                        month_first_votes += 1;
                    }
                }
                if classify(value) == CellKind::DateTime {
                    date_times += 1;
                } else {
                    dates += 1;
                }
            }
            _ => {}
        }
    }

    let date_order = if month_first_votes > day_first_votes { DateOrder::MonthFirst } else { DateOrder::DayFirst };
    if non_empty == 0 {
        return ColumnProfile { kind: ColumnType::Empty, date_order };
    }
    let threshold = (non_empty as f64) * TYPE_RATIO;
    let numeric = integers + decimals;
    let temporal = dates + date_times;
    let kind = if numeric as f64 >= threshold {
        if decimals == 0 { ColumnType::Integer } else { ColumnType::Decimal }
    } else if temporal as f64 >= threshold {
        if date_times > 0 { ColumnType::DateTime } else { ColumnType::Date }
    } else {
        ColumnType::Text
    };
    ColumnProfile { kind, date_order }
}

/// What a single cell looks like.
pub fn classify(value: &str) -> CellKind {
    let value = value.trim();
    if value.is_empty() {
        return CellKind::Empty;
    }
    if let Some(number) = parse_number(value) {
        return if number.fract() == 0.0 && !value.contains(['.', 'e', 'E']) {
            CellKind::Integer
        } else {
            CellKind::Decimal
        };
    }
    match parse_datetime_parts(value, DateOrder::DayFirst) {
        Some((_, true)) => CellKind::DateTime,
        Some((_, false)) => CellKind::Date,
        None => CellKind::Text,
    }
}

/// Lenient number parse: thousands separators (space, comma, apostrophe,
/// underscore), a decimal comma when it is clearly one, currency marks and
/// percent signs around the number, and (1 234) for negatives.
pub fn parse_number(value: &str) -> Option<f64> {
    let mut s = value.trim();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    let mut negative = false;
    if s.starts_with('(') && s.ends_with(')') {
        negative = true;
        s = &s[1..s.len() - 1];
    }
    // Currency or unit marks on either side: letters and symbols, not digits.
    let original = s;
    let s = s.trim_matches(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+')));
    let s = s.trim_end_matches(['+', '-']);
    if s.is_empty() {
        return None;
    }
    // A sign glued to letters is an identifier (WS-00017), not "minus 17".
    let start = s.as_ptr() as usize - original.as_ptr() as usize;
    if start > 0 && s.starts_with(['+', '-']) && original[..start].ends_with(|c: char| c.is_alphanumeric()) {
        return None;
    }
    // Letters glued to the digits make an identifier (user826, 10ms); a unit
    // or currency word needs a space (R 1 200, 10 kg). Symbols may touch ($5, 5%).
    let prefix = &original[..start];
    let suffix = &original[start + s.len()..];
    if prefix.ends_with(|c: char| c.is_alphanumeric()) || suffix.starts_with(|c: char| c.is_alphanumeric()) {
        return None;
    }
    // Unit or currency marks are short; a long word around a number is a label.
    if prefix.trim().len() > 4 || suffix.trim().len() > 4 {
        return None;
    }
    if !s.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }

    let mut cleaned = String::with_capacity(s.len());
    let has_dot = s.contains('.');
    let commas = s.matches(',').count();
    // Decide what commas mean: with a dot present they are thousands
    // separators; alone they are thousands separators when every group after
    // the first has three digits, otherwise a decimal comma.
    let comma_is_decimal = !has_dot && commas == 1 && {
        let after = &s[s.rfind(',').unwrap() + 1..];
        !(after.len() == 3 && after.bytes().all(|b| b.is_ascii_digit()))
    };
    let mut previous = '\0';
    for (i, c) in s.chars().enumerate() {
        match c {
            '0'..='9' | '.' => cleaned.push(c),
            '+' | '-' if i == 0 || previous == 'e' => cleaned.push(c),
            // Scientific notation as spreadsheets export it: 1.23E+15.
            'e' | 'E' if !cleaned.is_empty() && !cleaned.contains('e') => cleaned.push('e'),
            '-' => return None,
            ',' => {
                if comma_is_decimal {
                    cleaned.push('.');
                }
            }
            ' ' | '\u{a0}' | '\'' | '_' => {}
            _ => return None,
        }
        previous = if matches!(c, 'e' | 'E') { 'e' } else { c };
    }
    if cleaned.is_empty() || cleaned.matches('.').count() > 1 {
        return None;
    }
    let digits = cleaned.bytes().filter(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let parsed: f64 = cleaned.parse().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(if negative { -parsed } else { parsed })
}

/// Milliseconds since the Unix epoch for a date or date-time cell.
pub fn parse_datetime(value: &str, order: DateOrder) -> Option<i64> {
    parse_datetime_parts(value, order).map(|(millis, _)| millis)
}

/// (millis, had_time_part)
fn parse_datetime_parts(value: &str, order: DateOrder) -> Option<(i64, bool)> {
    let mut s = value.trim();
    if s.len() < 6 || s.len() > 40 {
        return None;
    }
    // "Mon, 01 Aug 2026 ..." style: drop a leading weekday.
    if let Some(rest) = strip_weekday(s) {
        s = rest;
    }

    let (year, month, day, rest) = parse_date_prefix(s, order)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let rest = rest.trim_start_matches(|c: char| c == 'T' || c == 't' || c == ' ' || c == ',');
    let (hour, minute, second, millis, offset_minutes, had_time) = if rest.is_empty() {
        (0, 0, 0, 0, 0, false)
    } else {
        let (h, m, sec, ms, off) = parse_time(rest)?;
        (h, m, sec, ms, off, true)
    };

    let days = days_from_civil(year, month as i64, day as i64);
    let mut total = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis;
    total -= offset_minutes * 60_000;
    Some((total, had_time))
}

fn strip_weekday(s: &str) -> Option<&str> {
    let lower = s.get(..3)?.to_ascii_lowercase();
    if !matches!(lower.as_str(), "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun") {
        return None;
    }
    let after = s.find(|c: char| c == ',' || c == ' ')?;
    Some(s[after..].trim_start_matches([',', ' ']))
}

/// Parse the date part; returns (year, month, day, remaining text).
fn parse_date_prefix(s: &str, order: DateOrder) -> Option<(i64, u32, u32, &str)> {
    let bytes = s.as_bytes();
    let digit_run = |from: usize| -> usize { bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count() };

    let first = digit_run(0);
    if first == 4 {
        // YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
        let year: i64 = s[..4].parse().ok()?;
        let sep = *bytes.get(4)?;
        if !matches!(sep, b'-' | b'/' | b'.') {
            return None;
        }
        let m_len = digit_run(5);
        if !(1..=2).contains(&m_len) || bytes.get(5 + m_len) != Some(&sep) {
            return None;
        }
        let month: u32 = s[5..5 + m_len].parse().ok()?;
        let d_start = 6 + m_len;
        let d_len = digit_run(d_start);
        if !(1..=2).contains(&d_len) {
            return None;
        }
        let day: u32 = s[d_start..d_start + d_len].parse().ok()?;
        return Some((year, month, day, &s[d_start + d_len..]));
    }
    if (1..=2).contains(&first) {
        let a: u32 = s[..first].parse().ok()?;
        let sep = *bytes.get(first)?;
        if matches!(sep, b'-' | b'/' | b'.') {
            // D/M/Y or M/D/Y with a four-digit year.
            let b_start = first + 1;
            let b_len = digit_run(b_start);
            if !(1..=2).contains(&b_len) || bytes.get(b_start + b_len) != Some(&sep) {
                return None;
            }
            let b: u32 = s[b_start..b_start + b_len].parse().ok()?;
            let y_start = b_start + b_len + 1;
            if digit_run(y_start) != 4 {
                return None;
            }
            let year: i64 = s[y_start..y_start + 4].parse().ok()?;
            let (day, month) = match order {
                DateOrder::DayFirst => (a, b),
                DateOrder::MonthFirst => (b, a),
            };
            // Whichever order was asked for, an impossible month means the
            // other reading was intended.
            let (day, month) = if month > 12 && day <= 12 { (month, day) } else { (day, month) };
            return Some((year, month, day, &s[y_start + 4..]));
        }
        if sep == b' ' {
            // "01 Aug 2026", "1 August 2026"
            let rest = &s[first + 1..];
            let (month, rest) = parse_month_name(rest)?;
            let rest = rest.trim_start_matches([' ', ',']);
            let y_len = rest.bytes().take_while(u8::is_ascii_digit).count();
            if y_len != 4 {
                return None;
            }
            let year: i64 = rest[..4].parse().ok()?;
            return Some((year, month, a, &rest[4..]));
        }
        return None;
    }
    if first == 0 {
        // "Aug 1, 2026", "August 1 2026"
        let (month, rest) = parse_month_name(s)?;
        let rest = rest.trim_start_matches(' ');
        let d_len = rest.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=2).contains(&d_len) {
            return None;
        }
        let day: u32 = rest[..d_len].parse().ok()?;
        let rest = rest[d_len..].trim_start_matches([',', ' ']);
        let y_len = rest.bytes().take_while(u8::is_ascii_digit).count();
        if y_len != 4 {
            return None;
        }
        let year: i64 = rest[..4].parse().ok()?;
        return Some((year, month, day, &rest[4..]));
    }
    None
}

fn parse_month_name(s: &str) -> Option<(u32, &str)> {
    let letters = s.bytes().take_while(|b| b.is_ascii_alphabetic()).count();
    if letters < 3 {
        return None;
    }
    let name = s[..letters].to_ascii_lowercase();
    const MONTHS: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    let month = MONTHS.iter().position(|full| full.starts_with(&name) && (name.len() == 3 || *full == name))? as u32 + 1;
    Some((month, &s[letters..].trim_start_matches('.')))
}

/// (hour, minute, second, millis, utc offset in minutes)
fn parse_time(s: &str) -> Option<(i64, i64, i64, i64, i64)> {
    let bytes = s.as_bytes();
    let run = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let h_len = run(0);
    if !(1..=2).contains(&h_len) || bytes.get(h_len) != Some(&b':') {
        return None;
    }
    let mut hour: i64 = s[..h_len].parse().ok()?;
    let m_start = h_len + 1;
    if run(m_start) != 2 {
        return None;
    }
    let minute: i64 = s[m_start..m_start + 2].parse().ok()?;
    let mut pos = m_start + 2;
    let mut second = 0i64;
    let mut millis = 0i64;
    if bytes.get(pos) == Some(&b':') && run(pos + 1) == 2 {
        second = s[pos + 1..pos + 3].parse().ok()?;
        pos += 3;
        if matches!(bytes.get(pos), Some(b'.') | Some(b',')) {
            let frac_len = run(pos + 1);
            if frac_len > 0 {
                let frac = &s[pos + 1..pos + 1 + frac_len.min(3)];
                let mut value: i64 = frac.parse().ok()?;
                for _ in frac.len()..3 {
                    value *= 10;
                }
                millis = value;
                pos += 1 + frac_len;
            }
        }
    }
    let rest = s[pos..].trim();
    let lower = rest.to_ascii_lowercase();
    let mut offset = 0i64;
    let mut tail = lower.as_str();
    if let Some(stripped) = tail.strip_prefix("am") {
        if hour == 12 {
            hour = 0;
        }
        tail = stripped.trim();
    } else if let Some(stripped) = tail.strip_prefix("pm") {
        if hour < 12 {
            hour += 12;
        }
        tail = stripped.trim();
    }
    if !tail.is_empty() {
        if tail == "z" || tail == "utc" || tail == "gmt" {
            offset = 0;
        } else if let Some(sign) = tail.chars().next().filter(|c| *c == '+' || *c == '-') {
            let body = &tail[1..];
            let (oh, om) = if let Some((h, m)) = body.split_once(':') {
                (h, m)
            } else if body.len() == 4 {
                (&body[..2], &body[2..])
            } else {
                (body, "0")
            };
            let oh: i64 = oh.parse().ok()?;
            let om: i64 = om.parse().ok()?;
            offset = oh * 60 + om;
            if sign == '-' {
                offset = -offset;
            }
        } else {
            return None;
        }
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some((hour, minute, second, millis, offset))
}

/// First two numbers of a numeric date, used to vote on day/month order.
fn leading_numeric_pair(value: &str) -> Option<(u32, u32)> {
    let bytes = value.as_bytes();
    let run = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let a_len = run(0);
    if !(1..=2).contains(&a_len) {
        return None;
    }
    let sep = *bytes.get(a_len)?;
    if !matches!(sep, b'-' | b'/' | b'.') {
        return None;
    }
    let b_len = run(a_len + 1);
    if !(1..=2).contains(&b_len) {
        return None;
    }
    let a = value[..a_len].parse().ok()?;
    let b = value[a_len + 1..a_len + 1 + b_len].parse().ok()?;
    Some((a, b))
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_with_separators_and_marks() {
        assert_eq!(parse_number("1,234.5"), Some(1234.5));
        assert_eq!(parse_number("1 234 567"), Some(1_234_567.0));
        assert_eq!(parse_number("R 1 200,50"), Some(1200.5));
        assert_eq!(parse_number("1,5"), Some(1.5));
        assert_eq!(parse_number("12,345"), Some(12345.0));
        assert_eq!(parse_number("$-3.25"), Some(-3.25));
        assert_eq!(parse_number("(42)"), Some(-42.0));
        assert_eq!(parse_number("99%"), Some(99.0));
        assert_eq!(parse_number("1e5"), Some(100_000.0));
        assert_eq!(parse_number("2026-08-01"), None);
        assert_eq!(parse_number("1.2.3"), None);
        assert_eq!(parse_number("inf"), None);
        assert_eq!(parse_number("NaN"), None);
        assert_eq!(parse_number("WS-00017"), None);
        assert_eq!(parse_number("user826"), None);
        assert_eq!(parse_number("10ms"), None);
        assert_eq!(parse_number("10 kg"), Some(10.0));
        assert_eq!(parse_number("ZAR 500"), Some(500.0));
        assert_eq!(parse_number("$5"), Some(5.0));
        assert_eq!(parse_number("abc"), None);
    }

    #[test]
    fn dates_in_common_layouts_agree() {
        let expected = parse_datetime("2026-08-01", DateOrder::DayFirst).unwrap();
        for text in ["2026/08/01", "2026.8.1", "01/08/2026", "1-8-2026", "01 Aug 2026", "1 August 2026", "Aug 1, 2026", "August 1 2026", "Sat, 01 Aug 2026"] {
            assert_eq!(parse_datetime(text, DateOrder::DayFirst), Some(expected), "{text}");
        }
        assert_eq!(parse_datetime("08/01/2026", DateOrder::MonthFirst), Some(expected));
        // An impossible month flips the reading.
        assert_eq!(parse_datetime("13/08/2026", DateOrder::MonthFirst), parse_datetime("2026-08-13", DateOrder::DayFirst));
    }

    #[test]
    fn times_zones_and_fractions() {
        let base = parse_datetime("2026-08-01", DateOrder::DayFirst).unwrap();
        assert_eq!(parse_datetime("2026-08-01T00:00:15", DateOrder::DayFirst), Some(base + 15_000));
        assert_eq!(parse_datetime("2026-08-01 10:30", DateOrder::DayFirst), Some(base + 10 * 3_600_000 + 30 * 60_000));
        assert_eq!(parse_datetime("2026-08-01T10:30:00.250Z", DateOrder::DayFirst), Some(base + 10 * 3_600_000 + 30 * 60_000 + 250));
        assert_eq!(parse_datetime("2026-08-01T12:00:00+02:00", DateOrder::DayFirst), Some(base + 10 * 3_600_000));
        assert_eq!(parse_datetime("01/08/2026 1:05 pm", DateOrder::DayFirst), Some(base + 13 * 3_600_000 + 5 * 60_000));
        assert_eq!(parse_datetime("2026-02-30", DateOrder::DayFirst), None);
        assert_eq!(parse_datetime("not a date", DateOrder::DayFirst), None);
        assert_eq!(parse_datetime("1347445", DateOrder::DayFirst), None);
    }

    #[test]
    fn column_types_from_samples() {
        let t = |values: &[&str]| detect_column_type(values.iter().copied()).kind;
        assert_eq!(t(&["1", "2", "", "3"]), ColumnType::Integer);
        assert_eq!(t(&["1.5", "2", "3.25"]), ColumnType::Decimal);
        assert_eq!(t(&["2026-08-01", "2026-08-02"]), ColumnType::Date);
        assert_eq!(t(&["2026-08-01T00:00:15", "2026-08-02T01:00:00"]), ColumnType::DateTime);
        assert_eq!(t(&["cmd.exe", "1", "chrome.exe"]), ColumnType::Text);
        assert_eq!(t(&["1", "2", "n/a", "4", "5"]), ColumnType::Integer);
        assert_eq!(t(&["", ""]), ColumnType::Empty);
        assert_eq!(t(&["4076884e5134d3afcdee845fadb72b05dfd164a0f529a92d827f32fdf3729e23"]), ColumnType::Text);
    }

    #[test]
    fn day_month_order_is_learned_from_the_sample() {
        let profile = detect_column_type(["03/04/2026", "25/04/2026"]);
        assert_eq!(profile.date_order, DateOrder::DayFirst);
        let profile = detect_column_type(["03/04/2026", "04/25/2026"]);
        assert_eq!(profile.date_order, DateOrder::MonthFirst);
    }
}
