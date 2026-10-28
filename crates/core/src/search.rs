use crate::{CoreError, CoreWorkspace, Result};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::UTF8, SearcherBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub max_results: u32,
}
impl Default for SearchQuery {
    fn default() -> Self {
        Self {
            text: String::new(),
            is_regex: false,
            case_sensitive: false,
            max_results: 10_000,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Immutable search view. Rope clones share storage until an editor transaction changes it.
pub struct WorkspaceSearch {
    pub(crate) workspace: CoreWorkspace,
}
impl WorkspaceSearch {
    pub fn search(&self, query: SearchQuery) -> Result<Vec<SearchMatch>> {
        self.workspace.search(query)
    }
    pub fn search_stream(
        &self,
        query: SearchQuery,
        cancellation: &CancellationToken,
        on_match: impl FnMut(SearchMatch) -> bool,
    ) -> Result<u32> {
        self.workspace.search_stream(query, cancellation, on_match)
    }
}

impl CoreWorkspace {
    pub fn search(&self, query: SearchQuery) -> Result<Vec<SearchMatch>> {
        let mut matches = Vec::new();
        self.search_stream(query, &CancellationToken::default(), |found| {
            matches.push(found);
            true
        })?;
        Ok(matches)
    }

    /// Emits the first result before traversing the rest of the workspace.
    /// Return false from the callback or cancel the token to stop work.
    pub fn search_stream(
        &self,
        query: SearchQuery,
        cancellation: &CancellationToken,
        mut on_match: impl FnMut(SearchMatch) -> bool,
    ) -> Result<u32> {
        if query.text.is_empty() || query.max_results == 0 {
            return Ok(0);
        }
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(!query.case_sensitive)
            .fixed_strings(!query.is_regex)
            .build(&query.text)
            .map_err(|e| CoreError::Search(e.to_string()))?;
        let root = self.scan_directory(&self.root)?;
        let walker = WalkBuilder::new(&root)
            .hidden(false)
            .require_git(false)
            .git_ignore(true)
            .git_exclude(true)
            .follow_links(false)
            .filter_entry(crate::workspace::visible_scan_entry)
            .build();
        let paths = walker.filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_some_and(|kind| kind.is_file()) => {
                Some(Ok(entry.into_path()))
            }
            Ok(_) => None,
            Err(error) if error.depth() == Some(0) => {
                Some(Err(CoreError::Search(error.to_string())))
            }
            Err(_) => None,
        });
        let new_buffers = self
            .buffers
            .keys()
            .filter(|path| !self.root.join(path).exists())
            .map(|path| Ok(self.root.join(path)));
        let mut count = 0;
        let mut stopped = false;
        for path in paths.chain(new_buffers) {
            if stopped || cancellation.is_cancelled() {
                break;
            }
            let path = path?;
            let original_relative = self.relative(&path)?;
            let (resolved, relative) = if self.buffers.contains_key(&original_relative) {
                // Existing authoritative text stays searchable even if its disk entry disappears.
                (path, original_relative)
            } else {
                let Some((resolved, metadata)) = self.scan_entry(&path) else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let relative = self.relative(&resolved)?;
                (resolved, relative)
            };
            let sink = UTF8(|line: u64, text: &str| {
                if cancellation.is_cancelled() {
                    stopped = true;
                    return Ok(false);
                }
                let found = matcher
                    .find(text.as_bytes())
                    .map_err(std::io::Error::other)?;
                if let Some(found) = found {
                    // Columns use UTF-16 to match CodeMirror, lines and columns are one based.
                    let column = text[..found.start()]
                        .encode_utf16()
                        .count()
                        .saturating_add(1);
                    count += 1;
                    stopped = !on_match(SearchMatch {
                        path: relative.clone(),
                        line: line.min(u32::MAX as u64) as u32,
                        column: column.min(u32::MAX as usize) as u32,
                        text: text.trim_end_matches(['\r', '\n']).to_owned(),
                    }) || count >= query.max_results;
                }
                Ok(!stopped)
            });
            let mut searcher = SearcherBuilder::new()
                .line_number(true)
                .binary_detection(grep_searcher::BinaryDetection::quit(b'\0'))
                .build();
            let result = if let Some(buffer) = self.buffers.get(&relative) {
                // Rope reader avoids materializing an extra document-sized String.
                searcher.search_reader(&matcher, RopeReader::new(&buffer.rope), sink)
            } else {
                searcher.search_path(&matcher, &resolved, sink)
            };
            // A child can vanish, lose access or become non-text after traversal. Keep other results usable.
            if result.is_err() {
                continue;
            }
        }
        Ok(count)
    }
}

struct RopeReader<'a> {
    chunks: ropey::iter::Chunks<'a>,
    current: &'a [u8],
}
impl<'a> RopeReader<'a> {
    fn new(rope: &'a ropey::Rope) -> Self {
        Self {
            chunks: rope.chunks(),
            current: &[],
        }
    }
}
impl std::io::Read for RopeReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.current.is_empty() {
            self.current = match self.chunks.next() {
                Some(chunk) => chunk.as_bytes(),
                None => return Ok(0),
            };
        }
        let count = buffer.len().min(self.current.len());
        buffer[..count].copy_from_slice(&self.current[..count]);
        self.current = &self.current[count..];
        Ok(count)
    }
}
