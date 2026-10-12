use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};

// Submodules share this module's imports and helpers through `use super::*`.
mod changes;
mod cli;
mod conflicts;
mod diff;
mod files;
mod history;
mod identity;
mod images;
mod log_stream;
mod operations;
mod partial;
mod reflog;
mod refs;
mod remote;
mod repo;
mod stash;
mod status;
mod structure;
#[cfg(test)]
mod tests;
mod tools;

pub use changes::*;
use cli::*;
pub use cli::{
    active_git, cancel_activity, check_git_executable, git_on_path, prepare_git_prefs,
    set_git_executable, with_background, with_cancel,
};
pub use conflicts::*;
pub use diff::*;
pub use files::*;
pub use history::*;
pub use identity::*;
pub use images::*;
pub use log_stream::*;
pub use operations::*;
pub use partial::*;
pub use reflog::*;
pub use refs::*;
pub use remote::*;
pub use stash::*;
pub use status::*;
pub use structure::*;
pub use tools::*;

use repo::{
    cat_blob, commit_info, config_get, config_get_file, config_get_global, config_get_local,
    config_get_system, config_set_file, config_set_global, config_set_local, config_unset_file,
    config_unset_global, config_unset_local, head_oid, identity_configured, index_matches_head,
    object_exists, peel_commit, ref_exists, remote_names, rev_parse, symbolic_branch, CommitInfo,
};
pub use repo::{discover, ignored_queries, open_at, Repository};

const MAX_TEXT_BYTES: u64 = 2_000_000;
const MAX_DIFF_LINES: usize = 4000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub current_branch: Option<String>,
    pub head_id: Option<String>,
    pub is_detached: bool,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    pub upstream: Option<String>,
    pub rebase: Option<RebaseProgress>,
    pub operation: Option<GitOperation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    pub kind: String,
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// The message git prepared for the commit that finishes this step.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseProgress {
    pub onto: Option<String>,
    pub head_name: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub id: String,
    pub short_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub id: String,
    pub action: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<CommitRefLabel>,
    pub on_current_branch: bool,
    pub on_tracking_branch: bool,
    /// The file's name at this commit, set only by per-file history.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRefLabel {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: String,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub commit: CommitSummary,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub current: Option<String>,
    pub is_detached: bool,
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<TagInfo>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub repo: RepoInfo,
    pub status: StatusSnapshot,
    pub branches: BranchList,
    pub remotes: Vec<RemoteInfo>,
    pub stashes: Vec<StashInfo>,
    pub head_commit: Option<CommitSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub id: String,
}

pub fn strip_verbatim_prefix(path: &str) -> String {
    let path = path.trim();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

fn strip_verbatim_path(path: PathBuf) -> PathBuf {
    PathBuf::from(strip_verbatim_prefix(&path.to_string_lossy()))
}

fn to_git_path(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_string()
}

fn looks_binary_path(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "bmp"
            | "pdf"
            | "zip"
            | "7z"
            | "rar"
            | "gz"
            | "tar"
            | "exe"
            | "dll"
            | "pdb"
            | "so"
            | "dylib"
            | "uasset"
            | "umap"
            | "ubulk"
            | "uexp"
            | "locres"
            | "archive"
            | "bin"
            | "dat"
            | "wasm"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
            | "mp3"
            | "mp4"
            | "wav"
            | "ogg"
    )
}

fn workdir(repo: &Repository) -> AppResult<&Path> {
    Ok(repo.workdir())
}

fn workdir_owned(repo: &Repository) -> AppResult<PathBuf> {
    Ok(workdir(repo)?.to_path_buf())
}

fn ensure_inside_workdir(repo: &Repository, relative: &str) -> AppResult<PathBuf> {
    let root = workdir_owned(repo)?.canonicalize()?;
    let candidate = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Ok(canonical) = candidate.canonicalize() {
        if !canonical.starts_with(&root) {
            return Err(AppError::msg("Path is outside the repository"));
        }
        return Ok(canonical);
    }
    if !candidate.starts_with(&root) {
        return Err(AppError::msg("Path is outside the repository"));
    }
    Ok(candidate)
}

pub fn canonical_workdir(repo: &Repository) -> AppResult<PathBuf> {
    let path = workdir_owned(repo)?;
    Ok(strip_verbatim_path(path.canonicalize().unwrap_or(path)))
}

fn safe_repo_path(path: &str) -> AppResult<String> {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Ok(String::new());
    }
    let invalid_part = |part: &str| {
        part.is_empty() || part == "." || part == ".." || (cfg!(windows) && part.contains(':'))
    };
    if path.split('/').any(invalid_part) || Path::new(path).has_root() {
        return Err(AppError::msg("Path is invalid"));
    }
    Ok(path.to_string())
}

fn short_id(id: &str) -> String {
    id.chars().take(7).collect()
}

pub fn open_in_file_manager(path: &str) -> AppResult<()> {
    let path = strip_verbatim_prefix(path);
    let command = if cfg!(windows) {
        let mut command = crate::locate::command("explorer");
        command.arg(&path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = crate::locate::command("open");
        command.arg(&path);
        command
    } else {
        let mut command = crate::locate::command("xdg-open");
        command.arg(&path);
        command
    };
    spawn_folder(command)
}

/// Opens the file manager with `path` selected.
pub fn reveal_in_file_manager(path: &str) -> AppResult<()> {
    let path = strip_verbatim_prefix(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = crate::locate::command("explorer");
        // Explorer parses its own arguments and needs the quotes after the comma.
        command.raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")));
        spawn_folder(command)
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = crate::locate::command("open");
        command.arg("-R").arg(&path);
        spawn_folder(command)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    reveal_linux(&path)
}

fn spawn_folder(mut command: Command) -> AppResult<()> {
    command
        .spawn()
        .map_err(|err| AppError::msg(format!("Could not open folder: {err}")))?;
    Ok(())
}

/// `file:///home/me/My%20File.txt`. Commas and spaces are encoded so `dbus-send`
/// keeps the URI as one argument.
#[cfg(any(test, not(any(windows, target_os = "macos"))))]
fn file_uri(path: &str) -> String {
    let mut out = String::from("file://");
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

#[cfg(not(any(windows, target_os = "macos")))]
fn reveal_linux(path: &str) -> AppResult<()> {
    let uri = file_uri(path);
    let shown = crate::locate::command("dbus-send")
        .args([
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            &format!("array:string:{uri}"),
            "string:",
        ])
        .status()
        .is_ok_and(|status| status.success());
    if shown {
        return Ok(());
    }
    let parent = Path::new(path).parent().unwrap_or(Path::new(path));
    let mut command = crate::locate::command("xdg-open");
    command.arg(parent);
    spawn_folder(command)
}

#[cfg(test)]
mod file_uri_tests {
    use super::file_uri;

    #[test]
    fn encodes_spaces_and_commas() {
        assert_eq!(
            file_uri("/home/me/My File.txt"),
            "file:///home/me/My%20File.txt"
        );
        assert_eq!(file_uri("/home/me/a,b.txt"), "file:///home/me/a%2Cb.txt");
    }
}
