use super::GitCommit;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryToolsQuery {
    pub heads: Vec<String>,
    pub skip: u32,
    pub limit: u32,
    pub author: Option<String>,
    pub message: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryDecoration {
    pub name: String,
    pub commit_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryToolsPage {
    pub heads: Vec<String>,
    pub refs: Vec<GitHistoryDecoration>,
    pub commits: Vec<GitCommit>,
    pub next_skip: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRevisionContent {
    pub revision: String,
    pub path: String,
    pub text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRevisionDiff {
    pub from: String,
    pub to: Option<String>,
    pub path: Option<String>,
    pub patch: String,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitReflogEntry {
    pub commit_id: String,
    pub selector: String,
    pub subject: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitReflogPage {
    pub entries: Vec<GitReflogEntry>,
    pub next_skip: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitSigningConfiguration {
    pub format: Option<String>,
    pub commit_signing: Option<String>,
    pub tag_signing: Option<String>,
}
