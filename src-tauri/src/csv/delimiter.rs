use super::parser::CsvUtf8Parser;
use std::io::Cursor;

const CANDIDATES: &[u8] = &[b',', b';', b'\t', b'|'];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DelimiterConfidence {
    High,
    Medium,
    Low,
}

impl DelimiterConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DelimiterDetection {
    pub delimiter: u8,
    pub confidence: DelimiterConfidence,
    pub sampled_rows: usize,
    pub likely_columns: usize,
    pub multi_column_rows: usize,
}

pub fn detect_delimiter(sample: &[u8]) -> DelimiterDetection {
    if sample.is_empty() {
        return DelimiterDetection {
            delimiter: b',',
            confidence: DelimiterConfidence::Low,
            sampled_rows: 0,
            likely_columns: 0,
            multi_column_rows: 0,
        };
    }

    let mut scores = CANDIDATES
        .iter()
        .copied()
        .map(|delimiter| score_delimiter(sample, delimiter))
        .collect::<Vec<_>>();
    scores.sort_by(|left, right| right.score.cmp(&left.score));

    let best = scores
        .first()
        .copied()
        .unwrap_or_else(|| CandidateScore::empty(b','));
    let runner_up = scores
        .get(1)
        .copied()
        .unwrap_or_else(|| CandidateScore::empty(b','));

    DelimiterDetection {
        delimiter: best.delimiter,
        confidence: classify_confidence(best, runner_up),
        sampled_rows: best.sampled_rows,
        likely_columns: best.mode_columns,
        multi_column_rows: best.multi_column_rows,
    }
}

#[derive(Clone, Copy)]
struct CandidateScore {
    delimiter: u8,
    score: i32,
    sampled_rows: usize,
    mode_columns: usize,
    consistent_rows: usize,
    multi_column_rows: usize,
}

impl CandidateScore {
    fn empty(delimiter: u8) -> Self {
        Self {
            delimiter,
            score: i32::MIN,
            sampled_rows: 0,
            mode_columns: 0,
            consistent_rows: 0,
            multi_column_rows: 0,
        }
    }
}

fn score_delimiter(sample: &[u8], delimiter: u8) -> CandidateScore {
    let cursor = Cursor::new(sample.to_vec());
    let mut parser = match CsvUtf8Parser::new(cursor, delimiter) {
        Ok(parser) => parser,
        Err(_) => return CandidateScore::empty(delimiter),
    };

    let mut counts: Vec<usize> = Vec::new();

    for _ in 0..256 {
        match parser.try_read_row() {
            Ok(Some(fields)) => counts.push(fields.len()),
            Ok(None) => break,
            Err(_) => return CandidateScore::empty(delimiter),
        }
    }

    if counts.is_empty() {
        return CandidateScore::empty(delimiter);
    }

    let mode = counts
        .iter()
        .copied()
        .fold(std::collections::HashMap::new(), |mut acc, n| {
            *acc.entry(n).or_insert(0) += 1;
            acc
        })
        .into_iter()
        .max_by_key(|(_, c)| *c)
        .map(|(n, _)| n)
        .unwrap_or(counts[0]);

    let multi_column_rows = counts.iter().filter(|&&c| c >= 2).count();
    if multi_column_rows == 0 {
        return CandidateScore {
            delimiter,
            score: -(counts.len() as i32),
            sampled_rows: counts.len(),
            mode_columns: mode,
            consistent_rows: counts.iter().filter(|&&c| c == mode).count(),
            multi_column_rows,
        };
    }

    let agreement = counts.iter().filter(|&&c| c == mode).count();
    let breadth = mode as i32 * 100;
    let anchor_penalty = (counts[0] as i32 - mode as i32).abs();

    CandidateScore {
        delimiter,
        score: multi_column_rows as i32 * 20_000 + agreement as i32 * 10_000 + breadth
            - anchor_penalty,
        sampled_rows: counts.len(),
        mode_columns: mode,
        consistent_rows: agreement,
        multi_column_rows,
    }
}

fn classify_confidence(best: CandidateScore, runner_up: CandidateScore) -> DelimiterConfidence {
    if best.multi_column_rows == 0 || best.sampled_rows == 0 || best.mode_columns < 2 {
        return DelimiterConfidence::Low;
    }

    let agreement_ratio = best.consistent_rows as f64 / best.sampled_rows as f64;
    let margin = best.score.saturating_sub(runner_up.score);

    if agreement_ratio >= 0.8 && margin >= 10_000 {
        return DelimiterConfidence::High;
    }

    if agreement_ratio >= 0.5 {
        return DelimiterConfidence::Medium;
    }

    DelimiterConfidence::Low
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_semicolon_when_fields_contain_json_commas() {
        let sample = concat!(
            "architectures;browser_extension;name\n",
            r#""[""x64""]";"{""id"": ""abc"", ""enabled"": false}";Google Docs Offline"#,
            "\n",
        );
        let detection = detect_delimiter(sample.as_bytes());
        assert_eq!(detection.delimiter, b';');
        assert_eq!(detection.confidence, DelimiterConfidence::High);
    }
}
