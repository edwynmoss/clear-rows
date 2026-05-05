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
