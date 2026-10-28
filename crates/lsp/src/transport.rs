//! Stdio transport with LSP Content-Length framing.
//!
//! Implements byte-correct Content-Length header parsing and UTF-8 JSON-RPC message framing
//! per the Language Server Protocol 3.17 specification.

use crate::error::{LspError, Result};
use bytes::{Buf, BytesMut};
use serde_json::Value;
use std::collections::VecDeque;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

const MAX_HEADER_SIZE: usize = 1024;
const MAX_STDERR_BUFFER: usize = 1024 * 1024; // 1 MB

pub struct StdioWriter {
    stdin: Mutex<ChildStdin>,
}

impl StdioWriter {
    pub fn new(stdin: ChildStdin) -> Self {
        Self {
            stdin: Mutex::new(stdin),
        }
    }

    pub async fn send(&self, message: &Value) -> Result<()> {
        let json = serde_json::to_string(message)?;
        let content = format!("Content-Length: {}\r\n\r\n{}", json.len(), json);
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(content.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }
}

pub struct StdioReader {
    stdout: BufReader<ChildStdout>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    read_buffer: BytesMut,
    pending_messages: VecDeque<Value>,
}

impl StdioReader {
    pub fn new(stdout: ChildStdout, stderr: ChildStderr) -> Self {
        let stderr_task = Some(tokio::spawn(Self::handle_stderr(stderr)));

        Self {
            stdout: BufReader::new(stdout),
            stderr_task,
            read_buffer: BytesMut::with_capacity(4096),
            pending_messages: VecDeque::new(),
        }
    }

    async fn handle_stderr(mut stderr: ChildStderr) {
        let mut buffer = BytesMut::with_capacity(4096);
        let mut total_size = 0;

        loop {
            match stderr.read_buf(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    total_size += n;
                    if total_size > MAX_STDERR_BUFFER {
                        let excess = total_size - MAX_STDERR_BUFFER;
                        buffer.advance(excess);
                        total_size = MAX_STDERR_BUFFER;
                    }

                    while let Some(newline_pos) = buffer.iter().position(|&b| b == b'\n') {
                        let line = buffer.split_to(newline_pos + 1);
                        if let Ok(text) = std::str::from_utf8(&line[..line.len().saturating_sub(1)])
                        {
                            eprintln!("[LSP stderr] {}", text);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }

    pub async fn receive(&mut self) -> Result<Value> {
        loop {
            if let Some(msg) = self.pending_messages.pop_front() {
                return Ok(msg);
            }

            self.try_parse_messages()?;

            if let Some(msg) = self.pending_messages.pop_front() {
                return Ok(msg);
            }

            let n = self.stdout.read_buf(&mut self.read_buffer).await?;
            if n == 0 {
                return Err(LspError::Protocol("Unexpected EOF".to_string()));
            }
        }
    }

    fn try_parse_messages(&mut self) -> Result<()> {
        loop {
            if self.read_buffer.is_empty() {
                break;
            }

            let header_end = match self.find_header_end() {
                Some(pos) => pos,
                None => {
                    if self.read_buffer.len() > MAX_HEADER_SIZE {
                        return Err(LspError::InvalidHeader("Header too large".to_string()));
                    }
                    break;
                }
            };

            let header_bytes = self.read_buffer.split_to(header_end);
            let headers = std::str::from_utf8(&header_bytes)
                .map_err(|_| LspError::InvalidHeader("Invalid UTF-8 in headers".to_string()))?;

            let content_length = self.parse_content_length(headers)?;

            if self.read_buffer.len() < content_length {
                let mut temp = BytesMut::with_capacity(header_end + self.read_buffer.len());
                temp.extend_from_slice(&header_bytes);
                temp.extend_from_slice(&self.read_buffer);
                self.read_buffer = temp;
                break;
            }

            let message_bytes = self.read_buffer.split_to(content_length);
            let message_str = std::str::from_utf8(&message_bytes)
                .map_err(|_| LspError::Protocol("Invalid UTF-8 in message body".to_string()))?;

            let message: Value = serde_json::from_str(message_str)?;
            self.pending_messages.push_back(message);
        }

        Ok(())
    }

    fn find_header_end(&self) -> Option<usize> {
        let bytes = &self.read_buffer[..];
        for i in 0..bytes.len().saturating_sub(3) {
            if &bytes[i..i + 4] == b"\r\n\r\n" {
                return Some(i + 4);
            }
        }
        None
    }

    fn parse_content_length(&self, headers: &str) -> Result<usize> {
        for line in headers.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Some((key, value)) = line.split_once(':') {
                if key.trim().eq_ignore_ascii_case("Content-Length") {
                    return value.trim().parse::<usize>().map_err(|_| {
                        LspError::InvalidHeader(format!("Invalid Content-Length: {}", value))
                    });
                }
            }
        }

        Err(LspError::InvalidHeader(
            "Missing Content-Length header".to_string(),
        ))
    }

    pub fn shutdown(&mut self) {
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
    }
}
