//! JSON-RPC 2.0 protocol handling for LSP.
//!
//! Implements request/response correlation, notifications, and server-initiated requests
//! per the Language Server Protocol 3.17 specification.

use crate::error::{LspError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Response(Response),
    Notification(Notification),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

impl PartialEq for RequestId {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (RequestId::Number(a), RequestId::Number(b)) => a == b,
            (RequestId::String(a), RequestId::String(b)) => a == b,
            _ => false,
        }
    }
}

impl Eq for RequestId {}

impl std::hash::Hash for RequestId {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match self {
            RequestId::Number(n) => {
                0u8.hash(state);
                n.hash(state);
            }
            RequestId::String(s) => {
                1u8.hash(state);
                s.hash(state);
            }
        }
    }
}

pub struct RequestIdGenerator {
    next_id: AtomicI64,
}

impl RequestIdGenerator {
    pub fn new() -> Self {
        Self {
            next_id: AtomicI64::new(1),
        }
    }

    pub fn next(&self) -> RequestId {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        RequestId::Number(id)
    }
}

impl Default for RequestIdGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl Message {
    pub fn parse(value: Value) -> Result<Self> {
        serde_json::from_value(value)
            .map_err(|e| LspError::Protocol(format!("Failed to parse message: {}", e)))
    }
}

impl Request {
    pub fn new(id: RequestId, method: String, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method,
            params,
        }
    }

    pub fn to_value(&self) -> Result<Value> {
        serde_json::to_value(self)
            .map_err(|e| LspError::Protocol(format!("Failed to serialize request: {}", e)))
    }
}

impl Response {
    pub fn success(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }
}

impl Notification {
    pub fn new(method: String, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method,
            params,
        }
    }

    pub fn to_value(&self) -> Result<Value> {
        serde_json::to_value(self)
            .map_err(|e| LspError::Protocol(format!("Failed to serialize notification: {}", e)))
    }
}
