use std::io::{Read, Seek, SeekFrom};

pub struct CsvUtf8Parser<R: Read + Seek> {
    stream: R,
    delimiter: u8,
    buf: Vec<u8>,
    buf_file_start: u64,
    len: usize,
    pos: usize,
    field_buf: Vec<u8>,
}

impl<R: Read + Seek> CsvUtf8Parser<R> {
    pub fn new(mut stream: R, delimiter: u8) -> std::io::Result<Self> {
        let start = stream.stream_position()?;
        Ok(Self {
            stream,
            delimiter,
            buf: vec![0u8; 256 * 1024],
            buf_file_start: start,
            len: 0,
            pos: 0,
            field_buf: Vec::with_capacity(256),
        })
    }

    pub fn seek(&mut self, absolute: u64) -> std::io::Result<()> {
        self.stream.seek(SeekFrom::Start(absolute))?;
        self.buf_file_start = absolute;
        self.len = 0;
        self.pos = 0;
        Ok(())
    }

    pub fn next_byte_offset(&self) -> u64 {
        self.buf_file_start + self.pos as u64
    }

    pub fn try_read_row(&mut self) -> std::io::Result<Option<Vec<String>>> {
        if !self.ensure_more_bytes()? {
            return Ok(None);
        }

        let mut fields: Vec<String> = Vec::with_capacity(16);
        loop {
            let (field, row_ended) = self.read_field()?;
            fields.push(field);

            if row_ended {
                return Ok(Some(fields));
            }
        }
    }

    /// Advances past one logical CSV row without allocating per-cell strings (for indexing / seeking).
    pub fn try_skip_row(&mut self) -> std::io::Result<Option<()>> {
        if !self.ensure_more_bytes()? {
            return Ok(None);
        }

        loop {
            let row_ended = self.skip_field()?;
            if row_ended {
                return Ok(Some(()));
            }
        }
    }

    fn skip_field(&mut self) -> std::io::Result<bool> {
        let mut row_ended = false;

        if !self.ensure_more_bytes()? {
            return Ok(true);
        }

        let quoted = self.buf[self.pos] == b'"';
        if quoted {
            self.advance(1);
        }

        if quoted {
            self.skip_quoted_field(&mut row_ended)?;
        } else {
            self.skip_unquoted_field(&mut row_ended)?;
        }

        Ok(row_ended)
    }

    fn skip_quoted_field(&mut self, row_ended: &mut bool) -> std::io::Result<()> {
        loop {
            if !self.ensure_more_bytes()? {
                *row_ended = true;
                return Ok(());
            }

            let b = self.buf[self.pos];

            if b != b'"' {
                self.advance(1);
                continue;
            }

            self.advance(1);

            if self.peek_is_escaped_quote() {
                self.advance(1);
                continue;
            }

            self.consume_after_quoted_field(row_ended)?;
            return Ok(());
        }
    }

    fn skip_unquoted_field(&mut self, row_ended: &mut bool) -> std::io::Result<()> {
        loop {
            if !self.ensure_more_bytes()? {
                *row_ended = true;
                return Ok(());
            }

            let b = self.buf[self.pos];

            if b == self.delimiter {
                self.advance(1);
                return Ok(());
            }

            if self.try_consume_row_terminator()? {
                *row_ended = true;
                return Ok(());
            }

            self.advance(1);
        }
    }

    fn ensure_more_bytes(&mut self) -> std::io::Result<bool> {
        while self.pos >= self.len {
            self.compact_if_needed();

            let read = self.stream.read(&mut self.buf[self.len..])?;
            if read == 0 {
                return Ok(false);
            }
            self.len += read;
        }

        Ok(true)
    }

    /// Best-effort: try to make at least `n` bytes available at `pos`.
    /// Returns true iff that succeeded; on EOF returns whatever's left.
    fn ensure_n_bytes(&mut self, n: usize) -> std::io::Result<bool> {
        while self.len - self.pos < n {
            self.compact_if_needed();

            if self.len == self.buf.len() {
                break;
            }

            let read = self.stream.read(&mut self.buf[self.len..])?;
            if read == 0 {
                break;
            }
            self.len += read;
        }

        Ok(self.len - self.pos >= n)
    }

    fn compact_if_needed(&mut self) {
        if self.pos == 0 {
            return;
        }

        if self.pos <= self.buf.len() / 2 {
            return;
        }

        let remaining = self.len - self.pos;
        self.buf.copy_within(self.pos..self.len, 0);
        self.buf_file_start += self.pos as u64;
        self.len = remaining;
        self.pos = 0;
    }

    fn read_field(&mut self) -> std::io::Result<(String, bool)> {
        let mut row_ended = false;
        self.field_buf.clear();

        if !self.ensure_more_bytes()? {
            return Ok((String::new(), true));
        }

        let quoted = self.buf[self.pos] == b'"';
        if quoted {
            self.advance(1);
        }

        if quoted {
            self.read_quoted_field(&mut row_ended)?;
        } else {
            self.read_unquoted_field(&mut row_ended)?;
        }

        let field = String::from_utf8_lossy(&self.field_buf).into_owned();
        Ok((field, row_ended))
    }

    fn read_quoted_field(&mut self, row_ended: &mut bool) -> std::io::Result<()> {
        loop {
            if !self.ensure_more_bytes()? {
                *row_ended = true;
                return Ok(());
            }

            let b = self.buf[self.pos];

            if b != b'"' {
                self.field_buf.push(b);
                self.advance(1);
                continue;
            }

            self.advance(1);

            if self.peek_is_escaped_quote() {
                self.field_buf.push(b'"');
                self.advance(1);
                continue;
            }

            self.consume_after_quoted_field(row_ended)?;
            return Ok(());
        }
    }

    fn read_unquoted_field(&mut self, row_ended: &mut bool) -> std::io::Result<()> {
        loop {
            if !self.ensure_more_bytes()? {
                *row_ended = true;
                return Ok(());
            }

            let b = self.buf[self.pos];

            if b == self.delimiter {
                self.advance(1);
                return Ok(());
            }

            if self.try_consume_row_terminator()? {
                *row_ended = true;
                return Ok(());
            }

            self.field_buf.push(b);
            self.advance(1);
        }
    }

    fn consume_after_quoted_field(&mut self, row_ended: &mut bool) -> std::io::Result<()> {
        loop {
            if !self.ensure_more_bytes()? {
                *row_ended = true;
                return Ok(());
            }

            let b = self.buf[self.pos];

            if b == self.delimiter {
                self.advance(1);
                *row_ended = false;
                return Ok(());
            }

            if self.try_consume_row_terminator()? {
                *row_ended = true;
                return Ok(());
            }

            if matches!(b, b' ' | b'\t') {
                self.advance(1);
                continue;
            }

            *row_ended = true;
            return Ok(());
        }
    }

    fn peek_is_escaped_quote(&self) -> bool {
        self.pos < self.len && self.buf[self.pos] == b'"'
    }

    fn try_consume_row_terminator(&mut self) -> std::io::Result<bool> {
        if !self.ensure_more_bytes()? {
            return Ok(false);
        }

        let b = self.buf[self.pos];

        if b == b'\n' {
            self.advance(1);
            return Ok(true);
        }

        if b != b'\r' {
            return Ok(false);
        }

        // Look ahead for \r\r\n, which appears in some Windows-encoded payloads
        // (e.g. when CRLF text is re-translated LF→CRLF and the CR survives).
        // Treat the whole sequence as one terminator so we don't emit a phantom
        // empty row for the leading lone \r. Checked before \r\n / lone-\r.
        self.ensure_n_bytes(3)?;
        if self.pos + 2 < self.len
            && self.buf[self.pos + 1] == b'\r'
            && self.buf[self.pos + 2] == b'\n'
        {
            self.advance(3);
            return Ok(true);
        }

        self.advance(1);

        if self.pos < self.len {
            if self.buf[self.pos] == b'\n' {
                self.advance(1);
            }
            return Ok(true);
        }

        if !self.ensure_more_bytes()? {
            return Ok(true);
        }

        if self.buf[self.pos] == b'\n' {
            self.advance(1);
        }

        Ok(true)
    }

    fn advance(&mut self, count: usize) {
        self.pos = (self.pos + count).min(self.len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(parser: &mut CsvUtf8Parser<Cursor<Vec<u8>>>) -> Vec<Vec<String>> {
        let mut rows = Vec::new();
        while let Some(row) = parser.try_read_row().expect("read row") {
            rows.push(row);
        }
        rows
    }

    #[test]
    fn parses_rows_terminated_by_crcrlf() {
        let data = b"a,b,c\r\r\n1,2,3\r\r\n4,5,6\r\r\n";
        let mut parser = CsvUtf8Parser::new(Cursor::new(data.to_vec()), b',').expect("parser");
        let rows = read_all(&mut parser);
        assert_eq!(
            rows,
            vec![
                vec!["a".to_owned(), "b".to_owned(), "c".to_owned()],
                vec!["1".to_owned(), "2".to_owned(), "3".to_owned()],
                vec!["4".to_owned(), "5".to_owned(), "6".to_owned()],
            ]
        );
    }

    #[test]
    fn crcrlf_does_not_emit_phantom_empty_rows() {
        // A naive lone-\r-then-\r\n parse would produce an empty row between
        // each data row. The fix should yield exactly two rows here.
        let data = b"h1,h2\r\r\nv1,v2\r\r\n";
        let mut parser = CsvUtf8Parser::new(Cursor::new(data.to_vec()), b',').expect("parser");
        let rows = read_all(&mut parser);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["h1".to_owned(), "h2".to_owned()]);
        assert_eq!(rows[1], vec!["v1".to_owned(), "v2".to_owned()]);
    }

    #[test]
    fn still_handles_plain_crlf_and_lone_cr() {
        let data = b"a,b\r\n1,2\rX,Y\n";
        let mut parser = CsvUtf8Parser::new(Cursor::new(data.to_vec()), b',').expect("parser");
        let rows = read_all(&mut parser);
        assert_eq!(
            rows,
            vec![
                vec!["a".to_owned(), "b".to_owned()],
                vec!["1".to_owned(), "2".to_owned()],
                vec!["X".to_owned(), "Y".to_owned()],
            ]
        );
    }
}
