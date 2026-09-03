//! Filter query grammar.
//!
//! A query is a whitespace-separated list of terms, all of which must match
//! (AND). Each term is:
//!
//! ```text
//!   value                 substring, any column, case-insensitive
//!   "a phrase"            substring with spaces
//!   /regex/               regex (case-insensitive), any column
//!   column:value          substring in one column
//!   column:"a phrase"
//!   column:/regex/
//!   column=value          exact match (case-insensitive, trimmed)
//!   -term                 negate any of the above
//!   "Column Name":value   quoted column names for headers with spaces
//!   #3:value              column by 1-based position
//! ```
//!
//! Column names resolve case-insensitively against the header row; spaces,
//! dashes and underscores are treated as equivalent so `command_line`,
//! `command-line` and `Command Line` all hit the same column.

use regex::{Regex, RegexBuilder};

#[derive(Debug)]
pub enum Matcher {
    /// Lowercased needle; matched against a lowercased cell.
    Contains(String),
    /// Lowercased, trimmed needle; cell must equal it after the same treatment.
    Exact(String),
    /// Case-insensitive regex matched against the raw cell.
    Regex(Regex),
}

#[derive(Debug)]
pub struct Term {
    pub negated: bool,
    /// Physical column index, or `None` for "any column".
    pub column: Option<usize>,
    pub matcher: Matcher,
}

#[derive(Debug, Default)]
pub struct CompiledQuery {
    pub terms: Vec<Term>,
}

impl CompiledQuery {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// Does `row` satisfy every term? `lower_buf` is scratch space reused
    /// across rows so the hot loop does not allocate.
    pub fn matches(&self, row: &[String], lower_buf: &mut String) -> bool {
        for term in &self.terms {
            let hit = match term.column {
                Some(index) => row
                    .get(index)
                    .map(|cell| term.matcher.test(cell, lower_buf))
                    .unwrap_or(false),
                None => row.iter().any(|cell| term.matcher.test(cell, lower_buf)),
            };
            if hit == term.negated {
                return false;
            }
        }
        true
    }
}

impl Matcher {
    fn test(&self, cell: &str, lower_buf: &mut String) -> bool {
        match self {
            Matcher::Contains(needle) => {
                if cell.is_empty() {
                    return needle.is_empty();
                }
                // Hot path: ASCII needle against any cell can be compared
                // case-insensitively byte-for-byte without building a
                // lowercase copy of the cell.
                if needle.is_ascii() {
                    return contains_ascii_ci(cell.as_bytes(), needle.as_bytes());
                }
                lowercase_into(cell, lower_buf);
                lower_buf.contains(needle.as_str())
            }
            Matcher::Exact(needle) => {
                lowercase_into(cell.trim(), lower_buf);
                lower_buf == needle
            }
            Matcher::Regex(regex) => regex.is_match(cell),
        }
    }
}

/// Case-insensitive ASCII substring search. Non-ASCII bytes in `haystack`
/// never equal an ASCII needle byte, so this stays correct for UTF-8 cells.
fn contains_ascii_ci(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.len() < needle.len() {
        return false;
    }
    let first = needle[0].to_ascii_lowercase();
    let last_start = haystack.len() - needle.len();
    let mut i = 0;
    while i <= last_start {
        if haystack[i].to_ascii_lowercase() == first
            && haystack[i..i + needle.len()].eq_ignore_ascii_case(needle)
        {
            return true;
        }
        i += 1;
    }
    false
}

fn lowercase_into(source: &str, buf: &mut String) {
    buf.clear();
    if source.is_ascii() {
        buf.push_str(source);
        buf.make_ascii_lowercase();
    } else {
        for ch in source.chars() {
            buf.extend(ch.to_lowercase());
        }
    }
}

/// Parse `input` against `headers`. Errors are user-facing sentences.
pub fn parse_query(input: &str, headers: &[String]) -> Result<CompiledQuery, String> {
    let mut terms = Vec::new();
    for raw in tokenize(input)? {
        if let Some(term) = parse_term(&raw, headers)? {
            terms.push(term);
        }
    }
    Ok(CompiledQuery { terms })
}

/// Split on whitespace, keeping `"..."` and `/.../` groups intact (including
/// when they follow a `column:` prefix).
fn tokenize(input: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '"' => {
                current.push('"');
                let mut closed = false;
                for inner in chars.by_ref() {
                    current.push(inner);
                    if inner == '"' {
                        closed = true;
                        break;
                    }
                }
                if !closed {
                    return Err("Unclosed quote in filter.".to_owned());
                }
            }
            '/' if current.is_empty() || current.ends_with(':') || current == "-" => {
                current.push('/');
                let mut closed = false;
                let mut escaped = false;
                for inner in chars.by_ref() {
                    current.push(inner);
                    if escaped {
                        escaped = false;
                        continue;
                    }
                    if inner == '\\' {
                        escaped = true;
                    } else if inner == '/' {
                        closed = true;
                        break;
                    }
                }
                if !closed {
                    return Err("Unclosed /regex/ in filter.".to_owned());
                }
            }
            other => current.push(other),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn parse_term(token: &str, headers: &[String]) -> Result<Option<Term>, String> {
    let (negated, body) = match token.strip_prefix('-') {
        Some(rest) if !rest.is_empty() => (true, rest),
        _ => (false, token),
    };

    // Split `column:value` / `column=value`. The column part may be quoted.
    let (column, op, value) = split_column(body);

    let column_index = match column {
        Some(name) => Some(resolve_column(name, headers)?),
        None => None,
    };

    let matcher = if op == Some('=') {
        let literal = unquote(value);
        if literal.is_empty() {
            return Err("Exact match needs a value after '='.".to_owned());
        }
        Matcher::Exact(literal.trim().to_lowercase())
    } else if let Some(pattern) = regex_body(value) {
        let regex = RegexBuilder::new(pattern)
            .case_insensitive(true)
            .size_limit(1 << 20)
            .build()
            .map_err(|err| format!("Invalid regex /{pattern}/: {}", short_regex_error(&err)))?;
        Matcher::Regex(regex)
    } else {
        let literal = unquote(value);
        if literal.is_empty() {
            // `column:` with nothing after it: ignore rather than error, so
            // typing feels forgiving.
            return Ok(None);
        }
        Matcher::Contains(literal.to_lowercase())
    };

    Ok(Some(Term {
        negated,
        column: column_index,
        matcher,
    }))
}

/// Returns `(column, operator, value)`. Operator is `:` or `=`; a token with
/// no operator is a bare value.
fn split_column(body: &str) -> (Option<&str>, Option<char>, &str) {
    let mut index = 0;
    let bytes = body.as_bytes();
    if bytes.first() == Some(&b'"') {
        // Quoted column name: find the closing quote, then expect an operator.
        if let Some(close) = body[1..].find('"') {
            let after = 1 + close + 1;
            if let Some(op) = body[after..].chars().next() {
                if op == ':' || op == '=' {
                    return (Some(&body[..after]), Some(op), &body[after + 1..]);
                }
            }
        }
        return (None, None, body);
    }
    // A leading `/` means the whole token is a regex, never a column.
    if bytes.first() == Some(&b'/') {
        return (None, None, body);
    }
    for ch in body.chars() {
        if ch == ':' || ch == '=' {
            if index == 0 {
                return (None, None, body);
            }
            return (Some(&body[..index]), Some(ch), &body[index + ch.len_utf8()..]);
        }
        index += ch.len_utf8();
    }
    (None, None, body)
}

fn unquote(value: &str) -> &str {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn regex_body(value: &str) -> Option<&str> {
    if value.len() >= 2 && value.starts_with('/') && value.ends_with('/') {
        Some(&value[1..value.len() - 1])
    } else {
        None
    }
}

fn short_regex_error(err: &regex::Error) -> String {
    err.to_string().lines().next().unwrap_or("syntax error").to_owned()
}

fn normalize_column_name(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn resolve_column(name: &str, headers: &[String]) -> Result<usize, String> {
    let name = unquote(name);
    if let Some(position) = name.strip_prefix('#') {
        return position
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1 && *n <= headers.len())
            .map(|n| n - 1)
            .ok_or_else(|| format!("There is no column #{position}; the file has {} columns.", headers.len()));
    }
    let wanted = normalize_column_name(name);
    if wanted.is_empty() {
        return Err("Column name is empty.".to_owned());
    }
    if let Some(index) = headers.iter().position(|h| normalize_column_name(h) == wanted) {
        return Ok(index);
    }
    // Unique prefix match as a convenience (`cmd` → `command_line`).
    let candidates: Vec<usize> = headers
        .iter()
        .enumerate()
        .filter(|(_, h)| normalize_column_name(h).starts_with(&wanted))
        .map(|(i, _)| i)
        .collect();
    match candidates.as_slice() {
        [single] => Ok(*single),
        [] => Err(format!(
            "Unknown column '{name}'. Columns: {}",
            headers.iter().map(|h| h.as_str()).collect::<Vec<_>>().join(", ")
        )),
        many => Err(format!(
            "'{name}' matches several columns: {}",
            many.iter().map(|i| headers[*i].as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers() -> Vec<String> {
        ["timestamp", "hostname", "process", "command_line", "severity"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|s| s.to_string()).collect()
    }

    fn matches(query: &str, cells: &[&str]) -> bool {
        let q = parse_query(query, &headers()).expect("parse");
        let mut buf = String::new();
        q.matches(&row(cells), &mut buf)
    }

    #[test]
    fn bare_word_matches_any_column_case_insensitively() {
        assert!(matches("POWERSHELL", &["t", "WS-1", "powershell.exe", "x", "low"]));
        assert!(!matches("chrome", &["t", "WS-1", "powershell.exe", "x", "low"]));
    }

    #[test]
    fn column_scoped_terms_and_are_anded() {
        let cells = ["t", "WS-1", "powershell.exe", "powershell -enc AAAA", "high"];
        assert!(matches("process:powershell command_line:-enc", &cells));
        assert!(!matches("process:chrome command_line:-enc", &cells));
        assert!(matches("severity=HIGH", &cells));
        assert!(!matches("severity=hig", &cells));
    }

    #[test]
    fn negation_quotes_and_regex() {
        let cells = ["t", "WS-1", "powershell.exe", "powershell -enc AAAA", "high"];
        assert!(matches("-process:chrome", &cells));
        assert!(!matches("-process:powershell", &cells));
        assert!(matches("\"-enc AAAA\"", &cells));
        assert!(matches("command_line:/-enc\\s+[A-Z]{4}/", &cells));
        assert!(matches("/^ws-\\d+$/", &cells));
        assert!(!matches("hostname:/^WS-9/", &cells));
    }

    #[test]
    fn column_names_are_forgiving() {
        let cells = ["t", "WS-1", "powershell.exe", "powershell -enc AAAA", "high"];
        assert!(matches("\"Command Line\":enc", &cells));
        assert!(matches("command-line:enc", &cells));
        assert!(matches("comm:enc", &cells));
        assert!(matches("#4:enc", &cells));
    }

    #[test]
    fn errors_are_sentences() {
        let err = parse_query("nope:x", &headers()).unwrap_err();
        assert!(err.starts_with("Unknown column 'nope'"), "{err}");
        let err = parse_query("process:/[/", &headers()).unwrap_err();
        assert!(err.starts_with("Invalid regex"), "{err}");
        let err = parse_query("\"unclosed", &headers()).unwrap_err();
        assert!(err.contains("Unclosed quote"), "{err}");
        let err = parse_query("#9:x", &headers()).unwrap_err();
        assert!(err.contains("no column #9"), "{err}");
    }

    #[test]
    fn empty_and_dangling_terms_are_ignored() {
        assert!(parse_query("   ", &headers()).unwrap().is_empty());
        assert!(parse_query("process:", &headers()).unwrap().is_empty());
    }
}
