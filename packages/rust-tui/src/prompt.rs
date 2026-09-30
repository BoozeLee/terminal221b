#[derive(Default, Debug, PartialEq, Eq)]
pub(super) struct PromptBuffer {
    text: String,
    cursor: usize,
    preferred_column: Option<usize>,
}

impl PromptBuffer {
    pub(super) fn as_str(&self) -> &str {
        &self.text
    }

    pub(super) fn cursor_byte(&self) -> usize {
        self.cursor
    }

    pub(super) fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.preferred_column = None;
    }

    pub(super) fn insert(&mut self, character: char) {
        self.text.insert(self.cursor, character);
        self.cursor += character.len_utf8();
        self.preferred_column = None;
    }

    pub(super) fn backspace(&mut self) {
        if let Some((start, _)) = self.text[..self.cursor].char_indices().next_back() {
            self.text.drain(start..self.cursor);
            self.cursor = start;
        }
        self.preferred_column = None;
    }

    pub(super) fn delete(&mut self) {
        if let Some(character) = self.text[self.cursor..].chars().next() {
            let end = self.cursor + character.len_utf8();
            self.text.drain(self.cursor..end);
        }
        self.preferred_column = None;
    }

    pub(super) fn move_left(&mut self) {
        if let Some((start, _)) = self.text[..self.cursor].char_indices().next_back() {
            self.cursor = start;
        }
        self.preferred_column = None;
    }

    pub(super) fn move_right(&mut self) {
        if let Some(character) = self.text[self.cursor..].chars().next() {
            self.cursor += character.len_utf8();
        }
        self.preferred_column = None;
    }

    pub(super) fn move_home(&mut self) {
        self.cursor = self.text[..self.cursor]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        self.preferred_column = None;
    }

    pub(super) fn move_end(&mut self) {
        self.cursor = self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |newline| self.cursor + newline);
        self.preferred_column = None;
    }

    pub(super) fn move_vertical(&mut self, down: bool) {
        let line_start = self.text[..self.cursor]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        let line_end = self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |newline| self.cursor + newline);
        let column = *self
            .preferred_column
            .get_or_insert_with(|| self.text[line_start..self.cursor].chars().count());
        let target_start = if down {
            if line_end == self.text.len() {
                return;
            }
            line_end + 1
        } else {
            if line_start == 0 {
                return;
            }
            self.text[..line_start - 1]
                .rfind('\n')
                .map_or(0, |newline| newline + 1)
        };
        let target_end = self.text[target_start..]
            .find('\n')
            .map_or(self.text.len(), |newline| target_start + newline);
        let target_column = self.text[target_start..target_end]
            .char_indices()
            .nth(column)
            .map_or(target_end, |(offset, _)| target_start + offset);
        self.cursor = target_column;
    }

    pub(super) fn cursor_line(&self) -> usize {
        self.text[..self.cursor].matches('\n').count()
    }

    pub(super) fn cursor_column(&self) -> usize {
        self.text[..self.cursor]
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .chars()
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_buffer_inserts_and_deletes_at_unicode_character_boundaries() {
        let mut input = PromptBuffer::default();
        for character in "aé猫".chars() {
            input.insert(character);
        }
        input.move_left();
        input.backspace();
        assert_eq!(input.as_str(), "a猫");
        assert_eq!(input.cursor_byte(), "a".len());
        input.delete();
        assert_eq!(input.as_str(), "a");
        assert_eq!(input.cursor_byte(), 1);
    }

    #[test]
    fn prompt_buffer_moves_across_lines_and_preserves_vertical_column() {
        let mut input = PromptBuffer::default();
        for character in "abcd\nxy\n1234".chars() {
            input.insert(character);
        }
        input.move_vertical(false);
        assert_eq!(&input.as_str()[input.cursor_byte()..], "\n1234");
        input.move_vertical(false);
        assert_eq!(input.cursor_byte(), 4);
        input.move_vertical(true);
        assert_eq!(input.cursor_byte(), 7);
        input.move_vertical(true);
        assert_eq!(input.cursor_byte(), input.as_str().len());
        input.move_home();
        assert_eq!(input.cursor_byte(), 8);
        input.move_end();
        assert_eq!(input.cursor_byte(), input.as_str().len());
    }
}
