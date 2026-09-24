use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use git2::{
    BranchType, DiffFormat, DiffOptions, ErrorCode, IndexAddOption, ObjectType, Oid, Repository,
    Sort, Status, StatusOptions,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};

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
pub struct BranchList {
    pub current: Option<String>,
    pub is_detached: bool,
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
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

fn is_delta_binary(delta: &git2::DiffDelta<'_>) -> bool {
    if delta.flags().contains(git2::DiffFlags::BINARY) {
        return true;
    }
    let path = delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .and_then(|path| path.to_str())
        .unwrap_or("");
    looks_binary_path(path)
}

fn workdir(repo: &Repository) -> AppResult<&Path> {
    repo.workdir()
        .ok_or_else(|| AppError::msg("Bare repositories are not supported yet"))
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

pub fn discover(path: &str) -> AppResult<Repository> {
    let path = strip_verbatim_prefix(path);
    let repo = Repository::discover(&path).map_err(|_| {
        AppError::msg(format!("No Git repository found at {path}"))
    })?;
    if repo.is_bare() {
        return Err(AppError::msg("Bare repositories are not supported yet"));
    }
    Ok(repo)
}

pub fn open_at(path: &Path) -> AppResult<Repository> {
    let repo = Repository::open(path)?;
    if repo.is_bare() {
        return Err(AppError::msg("Bare repositories are not supported yet"));
    }
    Ok(repo)
}

pub fn canonical_workdir(repo: &Repository) -> AppResult<PathBuf> {
    let path = workdir_owned(repo)?;
    Ok(strip_verbatim_path(path.canonicalize().unwrap_or(path)))
}

pub fn repo_info(repo: &Repository) -> AppResult<RepoInfo> {
    let path = canonical_workdir(repo)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository")
        .to_string();

    let current_branch;
    let mut head_id = None;
    let mut is_detached = false;
    let mut ahead = None;
    let mut behind = None;
    let mut upstream = None;

    match repo.head() {
        Ok(head) => {
            is_detached = !head.is_branch();
            current_branch = head.shorthand().map(|name| name.to_string());
            if let Some(oid) = head.target() {
                head_id = Some(oid.to_string());
            }
            if head.is_branch() {
                if let Ok(branch) = repo.find_branch(
                    head.shorthand().unwrap_or(""),
                    BranchType::Local,
                ) {
                    if let Ok(up) = branch.upstream() {
                        upstream = up.name()?.map(|name| name.to_string());
                        if let (Some(local_oid), Some(up_oid)) =
                            (branch.get().target(), up.get().target())
                        {
                            if let Some((a, b)) = cached_ahead_behind(repo, local_oid, up_oid) {
                                ahead = Some(a);
                                behind = Some(b);
                            }
                        }
                    }
                }
            }
        }
        Err(err) if err.code() == ErrorCode::UnbornBranch => {
            current_branch = repo.find_reference("HEAD").ok().and_then(|head| {
                head.symbolic_target().map(|target| {
                    target
                        .trim_start_matches("refs/heads/")
                        .to_string()
                })
            });
        }
        Err(err) => return Err(err.into()),
    }

    Ok(RepoInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        current_branch,
        head_id,
        is_detached,
        ahead,
        behind,
        upstream,
        rebase: rebase_progress(repo),
        operation: git_operation(repo),
    })
}

fn kind_from_status(status: Status, staged: bool) -> &'static str {
    if status.is_conflicted() {
        return "conflicted";
    }
    if staged {
        if status.is_index_new() {
            return "added";
        }
        if status.is_index_deleted() {
            return "deleted";
        }
        if status.is_index_renamed() {
            return "renamed";
        }
        if status.is_index_typechange() {
            return "typechange";
        }
        return "modified";
    }
    if status.is_wt_new() {
        return "untracked";
    }
    if status.is_wt_deleted() {
        return "deleted";
    }
    if status.is_wt_renamed() {
        return "renamed";
    }
    if status.is_wt_typechange() {
        return "typechange";
    }
    "modified"
}

pub fn status_snapshot(repo: &Repository) -> AppResult<StatusSnapshot> {
    let root = workdir(repo)?;
    if let Ok(snapshot) = status_from_git(root) {
        return Ok(snapshot);
    }
    status_from_libgit2(repo)
}

fn status_from_git(root: &Path) -> AppResult<StatusSnapshot> {
    let output = run_git(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=no",
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::msg(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    parse_porcelain(&output.stdout)
}

pub fn fetch_remote(
    repo: &mut Repository,
    remote: Option<&str>,
    all: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    if all {
        run_git_ok_progress(workdir(repo)?, &["fetch", "--all", "--progress"], on_progress)?;
    } else {
        match remote.map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => {
                run_git_ok_progress(workdir(repo)?, &["fetch", "--progress", name], on_progress)?
            }
            None => run_git_ok_progress(workdir(repo)?, &["fetch", "--progress"], on_progress)?,
        }
    }
    snapshot(repo)
}

pub fn pull_remote(
    repo: &mut Repository,
    remote: Option<&str>,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let mut args = vec!["pull".to_string(), "--progress".to_string()];
    if let Some(remote) = remote.map(str::trim).filter(|name| !name.is_empty()) {
        let branch = repo_info(repo)?
            .current_branch
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::msg("Cannot pull while HEAD is detached"))?;
        args.push(remote.to_string());
        args.push(branch);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Err(err) = run_git_ok_progress(workdir(repo)?, &arg_refs, on_progress) {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn push_remote(
    repo: &mut Repository,
    remote: Option<&str>,
    force: bool,
    set_upstream: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let branch = repo_info(repo)?
        .current_branch
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::msg("Cannot push while HEAD is detached"))?;
    let mut args = vec!["push".to_string(), "--progress".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
    }
    if set_upstream {
        args.push("--set-upstream".to_string());
    }
    if let Some(remote) = remote.map(str::trim).filter(|name| !name.is_empty()) {
        args.push(remote.to_string());
        args.push(branch);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok_progress(workdir(repo)?, &arg_refs, on_progress)?;
    snapshot(repo)
}

fn run_git(root: &Path, args: &[&str]) -> AppResult<std::process::Output> {
    run_git_env(root, args, &[])
}

fn run_git_env(
    root: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> AppResult<std::process::Output> {
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|err| AppError::msg(err.to_string()))
}

pub fn clone_repository(
    url: &str,
    destination: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<String> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("A repository URL is required"));
    }
    let dest = PathBuf::from(destination.trim());
    if dest.as_os_str().is_empty() {
        return Err(AppError::msg("A destination folder is required"));
    }
    let parent = dest
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| AppError::msg("A destination folder is required"))?;
    if !parent.is_dir() {
        return Err(AppError::msg("The parent folder does not exist"));
    }
    if dest.exists() {
        if !dest.is_dir() {
            return Err(AppError::msg("Destination already exists"));
        }
        let mut entries = fs::read_dir(&dest).map_err(|err| AppError::msg(err.to_string()))?;
        if entries.next().is_some() {
            return Err(AppError::msg("Destination already exists and is not empty"));
        }
    }
    let dest_arg = dest.to_string_lossy().into_owned();
    run_git_progress(
        None,
        &["clone", "--progress", "--", url, &dest_arg],
        on_progress,
    )?;
    let canonical = dest.canonicalize().unwrap_or(dest);
    Ok(strip_verbatim_prefix(&canonical.to_string_lossy()))
}

fn run_git_ok_progress(
    root: &Path,
    args: &[&str],
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    run_git_progress(Some(root), args, on_progress)
}

fn run_git_progress(
    root: Option<&Path>,
    args: &[&str],
    mut on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    if let Some(root) = root {
        command.arg("-C").arg(root);
    }
    command.args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel::<String>();

    let stderr_thread = stderr.map(|pipe| {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buf = Vec::new();
            while read_progress_line(&mut reader, &mut buf).unwrap_or(0) > 0 {
                let line = String::from_utf8_lossy(&buf).trim().to_string();
                if !line.is_empty() {
                    let _ = tx.send(line);
                }
            }
        })
    });
    drop(tx);

    let stdout_thread = stdout.map(|mut pipe| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    });

    let mut logs = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok(line) => {
                logs.push(line.clone());
                on_progress(&line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    while let Ok(line) = rx.try_recv() {
        logs.push(line.clone());
        on_progress(&line);
    }

    let status = child
        .wait()
        .map_err(|err| AppError::msg(err.to_string()))?;
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    let stdout_bytes = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = logs
        .into_iter()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(AppError::msg(if message.is_empty() {
        "Git command failed".to_string()
    } else {
        message
    }))
}

fn read_progress_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    buf.clear();
    loop {
        let consumed = {
            let available = match reader.fill_buf() {
                Ok(bytes) => bytes,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(err),
            };
            if available.is_empty() {
                return Ok(buf.len());
            }
            let mut take = 0;
            for byte in available {
                take += 1;
                if *byte == b'\n' || *byte == b'\r' {
                    break;
                }
                buf.push(*byte);
            }
            take
        };
        reader.consume(consumed);
        if buf.is_empty() {
            continue;
        }
        return Ok(buf.len());
    }
}

fn run_git_stdout(root: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    let output = run_git(root, args)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(AppError::msg(if message.is_empty() {
        "Git command failed".to_string()
    } else {
        message
    }))
}

fn find_git() -> Option<PathBuf> {
    if let Some(path) = which("git") {
        return Some(path);
    }
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\Git\cmd\git.exe",
        r"C:\Program Files\Git\bin\git.exe",
        r"C:\Program Files (x86)\Git\cmd\git.exe",
        "/usr/bin/git",
        "/usr/local/bin/git",
        "/opt/homebrew/bin/git",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let mut names = vec![name.to_string()];
    if let Ok(pathext) = std::env::var("PATHEXT") {
        for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
            names.push(format!("{name}{ext}"));
        }
    }
    for dir in std::env::split_paths(&paths) {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn parse_porcelain(bytes: &[u8]) -> AppResult<StatusSnapshot> {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut rest = bytes;

    while !rest.is_empty() {
        if rest[0] == 0 {
            rest = &rest[1..];
            continue;
        }
        if rest.len() < 3 {
            break;
        }
        let x = rest[0] as char;
        let y = rest[1] as char;
        rest = &rest[3..];
        let (first, next) = split_z(rest);
        let first = String::from_utf8_lossy(first).replace('\\', "/");
        let (path, old_path, next) = if matches!(x, 'R' | 'C') {
            let (second, next) = split_z(next);
            (
                String::from_utf8_lossy(second).replace('\\', "/"),
                Some(first),
                next,
            )
        } else {
            (first, None, next)
        };
        rest = next;

        if x == '?' || y == '?' {
            unstaged.push(FileStatus {
                path,
                old_path: None,
                kind: "untracked".to_string(),
                staged: false,
            });
            continue;
        }

        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            unstaged.push(FileStatus {
                path,
                old_path,
                kind: "conflicted".to_string(),
                staged: false,
            });
            continue;
        }

        if x != ' ' {
            staged.push(FileStatus {
                path: path.clone(),
                old_path: old_path.clone(),
                kind: kind_from_xy(x).to_string(),
                staged: true,
            });
        }
        if y != ' ' {
            unstaged.push(FileStatus {
                path,
                old_path,
                kind: kind_from_xy(y).to_string(),
                staged: false,
            });
        }
    }

    Ok(StatusSnapshot { staged, unstaged })
}

fn split_z(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().position(|&byte| byte == 0) {
        Some(index) => (&bytes[..index], &bytes[index + 1..]),
        None => (bytes, &[]),
    }
}

fn kind_from_xy(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    }
}

fn status_from_libgit2(repo: &Repository) -> AppResult<StatusSnapshot> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(false)
        .include_ignored(false)
        .exclude_submodules(true)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false);

    let statuses = repo.statuses(Some(&mut opts))?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_ignored() {
            continue;
        }

        let path = entry.path().unwrap_or_default().replace('\\', "/");
        let old_path = entry
            .head_to_index()
            .and_then(|delta| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"));

        let index_flags = Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE;

        if status.intersects(index_flags) || status.is_conflicted() {
            staged.push(FileStatus {
                path: path.clone(),
                old_path: old_path.clone(),
                kind: kind_from_status(status, true).to_string(),
                staged: true,
            });
        }

        let wt_flags = Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE
            | Status::CONFLICTED;

        if status.intersects(wt_flags) {
            unstaged.push(FileStatus {
                path,
                old_path,
                kind: kind_from_status(status, false).to_string(),
                staged: false,
            });
        }
    }

    Ok(StatusSnapshot { staged, unstaged })
}

pub fn stage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let mut index = repo.index()?;
    let root = workdir_owned(repo)?;
    for raw in paths {
        let rel = to_git_path(raw);
        if rel.is_empty() {
            continue;
        }
        let full = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if full.is_dir() {
            index.add_all([&rel], IndexAddOption::DEFAULT, None)?;
        } else if full.exists() {
            index.add_path(Path::new(&rel))?;
        } else {
            let _ = index.remove_path(Path::new(&rel));
        }
    }
    index.write()?;
    Ok(())
}

pub fn unstage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let specs: Vec<String> = paths.iter().map(|p| to_git_path(p)).collect();
    match repo.head() {
        Ok(head) => {
            let object = head.peel(ObjectType::Any)?;
            repo.reset_default(Some(&object), specs.iter())?;
        }
        Err(err) if err.code() == ErrorCode::UnbornBranch || err.code() == ErrorCode::NotFound => {
            let mut index = repo.index()?;
            for path in specs {
                let _ = index.remove_path(Path::new(&path));
            }
            index.write()?;
        }
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

fn is_untracked(status: Status) -> bool {
    status.is_wt_new()
        && !status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        )
}

fn remove_worktree_path(full: &Path) -> AppResult<()> {
    if full.is_dir() {
        fs::remove_dir_all(full)?;
    } else if full.exists() {
        fs::remove_file(full)?;
    }
    Ok(())
}

fn clear_readonly(full: &Path) -> AppResult<()> {
    if !full.is_file() {
        return Ok(());
    }
    let mut perms = fs::metadata(full)?.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        fs::set_permissions(full, perms)?;
    }
    Ok(())
}

fn restore_worktree_from_head(repo: &Repository, rel: &str, full: &Path) -> AppResult<()> {
    let head = repo.head()?;
    let in_head = head.peel_to_tree()?.get_path(Path::new(rel)).is_ok();
    if !in_head {
        remove_worktree_path(full)?;
        return Ok(());
    }
    // Match `git status` filters. Writing the raw blob turns a clean CRLF
    // worktree into LF, which stays listed with an empty diff.
    clear_readonly(full)?;
    run_git_stdout(workdir(repo)?, &["checkout", "HEAD", "--", rel])?;
    Ok(())
}

pub fn discard_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    for raw in paths {
        let rel = to_git_path(raw);
        if rel.is_empty() {
            continue;
        }
        let full = ensure_inside_workdir(repo, &rel)?;
        let status = repo.status_file(Path::new(&rel)).ok();
        let untracked = status.is_some_and(is_untracked);

        if untracked {
            remove_worktree_path(&full)?;
            continue;
        }

        match repo.head() {
            Ok(head) => {
                let object = head.peel(ObjectType::Any)?;
                repo.reset_default(Some(&object), [&rel])?;
                restore_worktree_from_head(repo, &rel, &full)?;
            }
            Err(err) if err.code() == ErrorCode::UnbornBranch => {
                let mut index = repo.index()?;
                let _ = index.remove_path(Path::new(&rel));
                index.write()?;
                remove_worktree_path(&full)?;
            }
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

pub fn commit(repo: &Repository, message: &str, amend: bool) -> AppResult<CommitSummary> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::msg("Commit message cannot be empty"));
    }

    let signature = repo.signature().map_err(|_| {
        AppError::msg("Set user.name and user.email in Git config before committing")
    })?;

    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    if amend {
        let head = match repo.head() {
            Ok(head) => head.peel_to_commit()?,
            Err(err) if err.code() == ErrorCode::UnbornBranch => {
                return Err(AppError::msg("Nothing to amend"));
            }
            Err(err) => return Err(err.into()),
        };
        let oid = head.amend(
            Some("HEAD"),
            Some(&signature),
            Some(&signature),
            None,
            Some(message),
            Some(&tree),
        )?;
        return summarize_oid(repo, oid);
    }

    let parent_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?),
        Err(err) if err.code() == ErrorCode::UnbornBranch => None,
        Err(err) => return Err(err.into()),
    };

    if let Some(parent) = &parent_commit {
        if parent.tree_id() == tree_id {
            return Err(AppError::msg("Nothing to commit"));
        }
    } else if index.is_empty() {
        return Err(AppError::msg("Nothing to commit"));
    }

    let parents: Vec<_> = parent_commit.iter().collect();
    let oid = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )?;
    summarize_oid(repo, oid)
}

fn summarize_oid(repo: &Repository, oid: Oid) -> AppResult<CommitSummary> {
    let commit = repo.find_commit(oid)?;
    let id = oid.to_string();
    let short_id = id.chars().take(7).collect();
    let author = commit.author();
    let author_name = author.name().unwrap_or("Unknown").to_string();
    let author_email = author.email().unwrap_or("").to_string();
    Ok(CommitSummary {
        id,
        short_id,
        summary: commit.summary().unwrap_or("").to_string(),
        body: commit.body().unwrap_or("").trim().to_string(),
        author_name,
        author_email,
        timestamp: commit.time().seconds(),
        parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
    })
}

pub fn commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: Option<&str>,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let revs = normalize_revs(revs);
    if let Some(query) = query {
        return search_commits(repo, limit, skip, query, &revs);
    }
    if let Ok(root) = workdir(repo) {
        let args = git_log_args(
            limit,
            skip,
            &revs,
            &["-c", "log.showSignature=false", "log", "--author-date-order"],
        );
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        if let Ok(stdout) = run_git_stdout(root, &argv) {
            let mut items = parse_git_log(&stdout)?;
            decorate_commits(repo, &mut items);
            return Ok(items);
        }
    }
    let mut items = commits_from_revwalk(repo, limit, skip, &revs)?;
    decorate_commits(repo, &mut items);
    Ok(items)
}

fn normalize_revs(revs: &[String]) -> Vec<String> {
    revs
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect()
}

fn push_all_branch_tips(args: &mut Vec<String>) {
    if let Some(index) = args.iter().position(|arg| arg == "log") {
        args.insert(index + 1, "--branches".to_string());
        args.insert(index + 2, "--remotes".to_string());
    } else {
        args.push("--branches".to_string());
        args.push("--remotes".to_string());
    }
}

fn git_log_args(limit: usize, skip: usize, revs: &[String], prefix: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = prefix.iter().map(|value| (*value).to_string()).collect();
    if revs.is_empty() {
        push_all_branch_tips(&mut args);
    }
    args.push(format!("-n{limit}"));
    args.push(format!("--skip={skip}"));
    args.push("--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P".to_string());
    args.extend(revs.iter().cloned());
    args
}

fn git_search_log_args(revs: &[String]) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "log.showSignature=false".to_string(),
        "-c".to_string(),
        "i18n.logOutputEncoding=utf-8".to_string(),
        "log".to_string(),
        "--author-date-order".to_string(),
    ];
    if revs.is_empty() {
        args.push("--branches".to_string());
        args.push("--remotes".to_string());
    }
    args.push("--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P".to_string());
    args.extend(revs.iter().cloned());
    args
}

fn search_commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: &str,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let needle = query.to_lowercase();
    let labels = collect_ref_labels(repo);
    let mut items = Vec::new();
    let mut skipped = 0usize;

    if let Ok(root) = workdir(repo) {
        let args = git_search_log_args(revs);
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut child = spawn_git_stdout(root, &argv)?;
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut record = Vec::new();
            while read_git_line(&mut reader, &mut record)? {
                let Some(commit) = parse_search_record(&record) else {
                    continue;
                };
                if !commit_matches(&commit, &needle, &labels) {
                    continue;
                }
                if skipped < skip {
                    skipped += 1;
                    continue;
                }
                items.push(commit);
                if items.len() >= limit {
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    apply_ref_labels(&mut items, &labels);
    mark_on_current_branch(repo, &mut items);
    Ok(items)
}

fn spawn_git_stdout(root: &Path, args: &[&str]) -> AppResult<std::process::Child> {
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))
}

fn read_git_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> AppResult<bool> {
    buf.clear();
    let read = reader
        .read_until(b'\n', buf)
        .map_err(|err| AppError::msg(err.to_string()))?;
    if read == 0 {
        return Ok(false);
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    if buf.is_empty() {
        return read_git_line(reader, buf);
    }
    Ok(true)
}

fn parse_search_record(bytes: &[u8]) -> Option<CommitSummary> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0');
    let id = normalize_oid(fields.next()?)?;
    let short_id = fields.next()?.trim().to_string();
    let summary = fields.next()?.to_string();
    let author_name = fields.next()?.trim().to_string();
    let author_email = fields.next()?.trim().to_string();
    let timestamp = fields.next()?.trim().parse().unwrap_or(0);
    let parents = fields.next().unwrap_or("");
    if short_id.is_empty() {
        return None;
    }
    Some(CommitSummary {
        id,
        short_id,
        summary,
        body: String::new(),
        author_name,
        author_email,
        timestamp,
        parents: parents
            .split_whitespace()
            .filter_map(normalize_oid)
            .collect(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
    })
}

fn normalize_oid(value: &str) -> Option<String> {
    let value = value.trim();
    let len = value.len();
    if (4..=40).contains(&len) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(value.to_string())
    } else {
        None
    }
}

fn commit_matches(
    commit: &CommitSummary,
    needle: &str,
    labels: &HashMap<String, Vec<CommitRefLabel>>,
) -> bool {
    if needle.is_empty() {
        return true;
    }
    let hash = commit.id.to_lowercase();
    if hash.starts_with(needle) || commit.short_id.to_lowercase().starts_with(needle) {
        return true;
    }
    if commit.summary.to_lowercase().contains(needle)
        || commit.body.to_lowercase().contains(needle)
        || commit.author_name.to_lowercase().contains(needle)
        || commit.author_email.to_lowercase().contains(needle)
    {
        return true;
    }
    labels.get(&commit.id).is_some_and(|refs| {
        refs.iter()
            .any(|label| label.name.to_lowercase().contains(needle))
    })
}

fn commits_from_revwalk(
    repo: &Repository,
    limit: usize,
    skip: usize,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let mut revwalk = repo.revwalk()?;
    if revs.is_empty() {
        let _ = revwalk.push_glob("refs/heads/*");
        let _ = revwalk.push_glob("refs/remotes/*");
    } else {
        for rev in revs {
            let object = repo.revparse_single(rev)?;
            revwalk.push(object.peel_to_commit()?.id())?;
        }
    }
    // TIME | TOPOLOGICAL matches `git log --date-order` (committer time, parents
    // still below their children). The CLI path above uses author time, which is
    // what the history column shows.
    revwalk.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;

    let mut items = Vec::new();
    for oid in revwalk.skip(skip).take(limit) {
        items.push(summarize_oid(repo, oid?)?);
    }
    Ok(items)
}

fn parse_git_log(bytes: &[u8]) -> AppResult<Vec<CommitSummary>> {
    let text = String::from_utf8_lossy(bytes);
    let mut items = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\0');
        let Some(id) = fields.next() else { continue };
        let Some(short_id) = fields.next() else { continue };
        let Some(summary) = fields.next() else { continue };
        let Some(author_name) = fields.next() else { continue };
        let Some(author_email) = fields.next() else { continue };
        let Some(timestamp) = fields.next() else { continue };
        let parents = fields.next().unwrap_or("");
        items.push(CommitSummary {
            id: id.to_string(),
            short_id: short_id.to_string(),
            summary: summary.to_string(),
            body: String::new(),
            author_name: author_name.to_string(),
            author_email: author_email.to_string(),
            timestamp: timestamp.parse().unwrap_or(0),
            parents: if parents.is_empty() {
                Vec::new()
            } else {
                parents.split_whitespace().map(str::to_string).collect()
            },
            refs: Vec::new(),
            on_current_branch: true,
            on_tracking_branch: false,
        });
    }
    Ok(items)
}

fn decorate_commits(repo: &Repository, commits: &mut [CommitSummary]) {
    let labels = collect_ref_labels(repo);
    apply_ref_labels(commits, &labels);
    mark_on_current_branch(repo, commits);
}

fn mark_on_current_branch(repo: &Repository, commits: &mut [CommitSummary]) {
    let head = repo.head().ok();
    let head_oid = head.as_ref().and_then(|head| head.target());
    let upstream_oid = head.as_ref().and_then(|head| upstream_oid_of(repo, head));
    if commit_graph_available(repo) {
        mark_branch_flags_with_graph(repo, commits, head_oid, upstream_oid);
        return;
    }
    let on_head = head_oid.and_then(|oid| reachable_commits(repo, oid));
    let on_upstream = upstream_oid.and_then(|oid| reachable_commits(repo, oid));
    if (on_head.is_none() && head_oid.is_some())
        || (on_upstream.is_none() && upstream_oid.is_some())
    {
        mark_branch_flags_with_graph(repo, commits, head_oid, upstream_oid);
        return;
    }
    let head_id = head_oid.map(|oid| oid.to_string());
    let upstream_id = upstream_oid.map(|oid| oid.to_string());
    for commit in commits {
        let Ok(oid) = Oid::from_str(&commit.id) else {
            commit.on_current_branch = head_id.as_deref() == Some(commit.id.as_str());
            commit.on_tracking_branch = upstream_id.as_deref() == Some(commit.id.as_str());
            continue;
        };
        commit.on_current_branch = on_head.as_ref().is_some_and(|set| set.contains(&oid));
        commit.on_tracking_branch = on_upstream.as_ref().is_some_and(|set| set.contains(&oid));
    }
}

fn mark_branch_flags_with_graph(
    repo: &Repository,
    commits: &mut [CommitSummary],
    head_oid: Option<Oid>,
    upstream_oid: Option<Oid>,
) {
    let head_id = head_oid.map(|oid| oid.to_string());
    let upstream_id = upstream_oid.map(|oid| oid.to_string());
    for commit in commits {
        let Ok(oid) = Oid::from_str(&commit.id) else {
            commit.on_current_branch = head_id.as_deref() == Some(commit.id.as_str());
            commit.on_tracking_branch = upstream_id.as_deref() == Some(commit.id.as_str());
            continue;
        };
        commit.on_current_branch = contains_commit(repo, head_oid, &head_id, oid, &commit.id);
        commit.on_tracking_branch =
            contains_commit(repo, upstream_oid, &upstream_id, oid, &commit.id);
    }
}

fn commit_graph_available(repo: &Repository) -> bool {
    let git_dir = repo.path();
    if git_dir.join("objects/info/commit-graph").is_file() {
        return true;
    }
    git_dir
        .join("objects/info/commit-graphs")
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn reachable_commits(repo: &Repository, tip: Oid) -> Option<Arc<HashSet<Oid>>> {
    enum Cached {
        Set(Arc<HashSet<Oid>>),
        TooBig,
    }
    const MAX_REACHABLE: usize = 2_000_000;
    static CACHE: OnceLock<Mutex<Vec<(Oid, Cached)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((_, cached)) = guard.iter().find(|(oid, _)| *oid == tip) {
            return match cached {
                Cached::Set(set) => Some(Arc::clone(set)),
                Cached::TooBig => None,
            };
        }
    }

    let cached = match walk_reachable(repo, tip, MAX_REACHABLE) {
        Some(set) => Cached::Set(Arc::new(set)),
        None => Cached::TooBig,
    };
    let result = match &cached {
        Cached::Set(set) => Some(Arc::clone(set)),
        Cached::TooBig => None,
    };
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|(oid, _)| *oid != tip);
        guard.push((tip, cached));
        if guard.len() > 4 {
            let extra = guard.len() - 4;
            guard.drain(0..extra);
        }
    }
    result
}

fn walk_reachable(repo: &Repository, tip: Oid, limit: usize) -> Option<HashSet<Oid>> {
    let mut walk = repo.revwalk().ok()?;
    walk.push(tip).ok()?;
    let mut set = HashSet::new();
    for oid in walk.flatten() {
        set.insert(oid);
        if set.len() > limit {
            return None;
        }
    }
    if set.is_empty() {
        return None;
    }
    Some(set)
}

fn upstream_oid_of(repo: &Repository, head: &git2::Reference) -> Option<Oid> {
    if !head.is_branch() {
        return None;
    }
    let branch = repo
        .find_branch(head.shorthand()?, BranchType::Local)
        .ok()?;
    branch.upstream().ok()?.get().target()
}

fn contains_commit(
    repo: &Repository,
    tip: Option<Oid>,
    tip_id: &Option<String>,
    oid: Oid,
    id: &str,
) -> bool {
    if tip_id.as_deref() == Some(id) {
        return true;
    }
    let Some(tip) = tip else {
        return false;
    };
    repo.graph_descendant_of(tip, oid).unwrap_or(false)
}

fn apply_ref_labels(
    commits: &mut [CommitSummary],
    labels: &HashMap<String, Vec<CommitRefLabel>>,
) {
    for commit in commits {
        if let Some(mut refs) = labels.get(&commit.id).cloned() {
            refs.sort_by(|left, right| {
                ref_kind_rank(&left.kind)
                    .cmp(&ref_kind_rank(&right.kind))
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            });
            commit.refs = refs;
        }
    }
}

fn ref_kind_rank(kind: &str) -> u8 {
    match kind {
        "head" => 0,
        "branch" => 1,
        "tag" => 2,
        _ => 3,
    }
}

fn collect_ref_labels(repo: &Repository) -> HashMap<String, Vec<CommitRefLabel>> {
    let mut labels: HashMap<String, Vec<CommitRefLabel>> = HashMap::new();
    let remote_names = configured_remote_names(repo);
    if let Ok(root) = workdir(repo) {
        if let Ok(stdout) = run_git_stdout(
            root,
            &[
                "for-each-ref",
                "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%00%(refname)%00%(HEAD)",
                "refs/heads",
                "refs/tags",
                "refs/remotes",
            ],
        ) {
            let text = String::from_utf8_lossy(&stdout);
            for line in text.split('\n') {
                if line.is_empty() {
                    continue;
                }
                let mut fields = line.split('\0');
                let Some(oid) = fields.next() else { continue };
                let Some(refname) = fields.next() else { continue };
                let (kind, name) = if let Some(name) = refname.strip_prefix("refs/heads/") {
                    ("branch", name)
                } else if let Some(name) = refname.strip_prefix("refs/tags/") {
                    ("tag", name)
                } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
                    if !is_remote_branch_name(name, &remote_names) {
                        continue;
                    }
                    ("branch", name)
                } else {
                    continue;
                };
                if name.is_empty() {
                    continue;
                }
                labels.entry(oid.to_string()).or_default().push(CommitRefLabel {
                    name: name.to_string(),
                    kind: kind.to_string(),
                });
            }
        }
    }

    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            let entry = labels.entry(oid.to_string()).or_default();
            if !entry.iter().any(|label| label.kind == "head") {
                entry.insert(
                    0,
                    CommitRefLabel {
                        name: "HEAD".to_string(),
                        kind: "head".to_string(),
                    },
                );
            }
        }
    }
    labels
}

fn collect_patch(diff: git2::Diff<'_>, fallback_path: &str) -> AppResult<FileDiff> {
    let mut path = fallback_path.to_string();
    let mut old_path = None;
    let mut binary = looks_binary_path(fallback_path);

    for delta in diff.deltas() {
        if let Some(new_path) = delta.new_file().path() {
            path = new_path.to_string_lossy().replace('\\', "/");
        }
        if let Some(prev) = delta.old_file().path() {
            let prev = prev.to_string_lossy().replace('\\', "/");
            if prev != path {
                old_path = Some(prev);
            }
        }
        if is_delta_binary(&delta) {
            binary = true;
        }
    }

    if binary {
        return Ok(FileDiff {
            path,
            old_path,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        });
    }

    let mut lines = Vec::new();
    let mut truncated = false;
    let print_result = diff.print(DiffFormat::Patch, |_, _, line| {
        if binary || truncated {
            return true;
        }
        if matches!(line.origin(), 'B') || line.content().contains(&0) {
            binary = true;
            lines.clear();
            return true;
        }
        if hunk_or_meta_only(line.origin()) && matches!(line.origin(), 'F' | 'G' | 'I' | 'B') {
            let content = String::from_utf8_lossy(line.content());
            if content.to_ascii_lowercase().contains("binary") {
                binary = true;
                lines.clear();
            }
            return true;
        }

        let kind = match line.origin() {
            '+' => "add",
            '-' => "delete",
            ' ' => "context",
            'H' | '@' => "hunk",
            _ => "meta",
        };
        if kind == "meta" {
            return true;
        }
        if lines.len() >= 4000 {
            truncated = true;
            return true;
        }

        let mut content = String::from_utf8_lossy(line.content()).into_owned();
        if content.ends_with('\n') {
            content.pop();
        }

        lines.push(DiffLine {
            kind: kind.to_string(),
            content,
            old_lineno: line.old_lineno(),
            new_lineno: line.new_lineno(),
        });
        true
    });

    if let Err(err) = print_result {
        if err.code() != ErrorCode::User {
            return Err(err.into());
        }
        truncated = true;
    }

    if binary {
        return Ok(FileDiff {
            path,
            old_path,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        });
    }

    Ok(FileDiff {
        path,
        old_path,
        binary: false,
        truncated,
        lines,
    })
}

fn hunk_or_meta_only(origin: char) -> bool {
    matches!(origin, 'F' | 'G' | 'I' | 'B' | 'H')
}

fn diff_options_for(path: &str, include_untracked: bool) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.pathspec(path).minimal(true);
    if include_untracked {
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
    }
    opts
}

pub fn workdir_diff(repo: &Repository, path: &str, staged: bool) -> AppResult<FileDiff> {
    let rel = to_git_path(path);
    let mut opts = diff_options_for(&rel, !staged);
    let diff = if staged {
        let head_tree = match repo.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(err) if err.code() == ErrorCode::UnbornBranch => None,
            Err(err) => return Err(err.into()),
        };
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };
    let file_diff = collect_patch(diff, &rel)?;
    if !staged && !file_diff.binary && file_diff.lines.is_empty() {
        if let Some(fallback) = untracked_workdir_diff(repo, &rel)? {
            return Ok(fallback);
        }
    }
    Ok(file_diff)
}

fn untracked_workdir_diff(repo: &Repository, path: &str) -> AppResult<Option<FileDiff>> {
    let status = match repo.status_file(Path::new(path)) {
        Ok(status) => status,
        Err(_) => return Ok(None),
    };
    if !is_untracked(status) {
        return Ok(None);
    }
    if looks_binary_path(path) {
        return Ok(Some(FileDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        }));
    }

    let abs = ensure_inside_workdir(repo, path)?;
    if !abs.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&abs)?;
    if bytes.contains(&0) {
        return Ok(Some(FileDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        }));
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut lines = Vec::new();
    let mut truncated = false;
    for (index, line) in text.split('\n').enumerate() {
        if lines.len() >= 4000 {
            truncated = true;
            break;
        }
        let content = line.strip_suffix('\r').unwrap_or(line).to_string();
        lines.push(DiffLine {
            kind: "add".to_string(),
            content,
            old_lineno: None,
            new_lineno: Some((index + 1) as u32),
        });
    }
    Ok(Some(FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated,
        lines,
    }))
}

fn delta_kind(delta: git2::Delta) -> &'static str {
    match delta {
        git2::Delta::Added => "added",
        git2::Delta::Deleted => "deleted",
        git2::Delta::Renamed => "renamed",
        git2::Delta::Copied => "copied",
        git2::Delta::Typechange => "typechange",
        git2::Delta::Untracked => "untracked",
        git2::Delta::Conflicted => "conflicted",
        _ => "modified",
    }
}

pub fn commit_details(repo: &Repository, oid: &str) -> AppResult<CommitDetails> {
    let oid = oid.trim();
    let parsed = Oid::from_str(oid)?;
    let files = if let Ok(root) = workdir(repo) {
        match commit_files_from_git(root, oid) {
            Ok(files) => files,
            Err(_) => commit_files_from_git2(repo, parsed)?,
        }
    } else {
        commit_files_from_git2(repo, parsed)?
    };
    Ok(CommitDetails {
        commit: summarize_oid(repo, parsed)?,
        files,
    })
}

fn commit_files_from_git(root: &Path, oid: &str) -> AppResult<Vec<CommitFile>> {
    let stdout = run_git_stdout(
        root,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "--no-renames",
            "--root",
            "-z",
            oid,
        ],
    )?;
    parse_name_status_z(&stdout)
}

fn parse_name_status_z(bytes: &[u8]) -> AppResult<Vec<CommitFile>> {
    let mut files = Vec::new();
    let mut parts = bytes.split(|b| *b == 0);
    while let Some(status) = parts.next() {
        if status.is_empty() {
            continue;
        }
        let status = std::str::from_utf8(status).unwrap_or("");
        let kind = match status.as_bytes().first() {
            Some(b'A') => "added",
            Some(b'D') => "deleted",
            Some(b'R') => "renamed",
            Some(b'C') => "copied",
            Some(b'T') => "typechange",
            Some(b'U') => "conflicted",
            _ => "modified",
        };
        let first = match parts.next() {
            Some(path) if !path.is_empty() => String::from_utf8_lossy(path).replace('\\', "/"),
            _ => continue,
        };
        let (path, old_path) = if matches!(kind, "renamed" | "copied") {
            match parts.next() {
                Some(path) if !path.is_empty() => {
                    (String::from_utf8_lossy(path).replace('\\', "/"), Some(first))
                }
                _ => (first, None),
            }
        } else {
            (first, None)
        };
        files.push(CommitFile {
            binary: looks_binary_path(&path),
            path,
            old_path,
            kind: kind.to_string(),
        });
    }
    Ok(files)
}

fn commit_files_from_git2(repo: &Repository, oid: Oid) -> AppResult<Vec<CommitFile>> {
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };
    let mut opts = DiffOptions::new();
    opts.skip_binary_check(true);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    let mut files = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .filter(|old| old != &path);
            files.push(CommitFile {
                binary: looks_binary_path(&path),
                path,
                old_path,
                kind: delta_kind(delta.status()).to_string(),
            });
            true
        },
        None,
        None,
        None,
    )?;
    Ok(files)
}

pub fn commit_file_diff(repo: &Repository, oid: &str, path: &str) -> AppResult<FileDiff> {
    let oid = Oid::from_str(oid.trim())?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };
    let rel = to_git_path(path);
    let mut opts = diff_options_for(&rel, false);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    collect_patch(diff, &rel)
}

pub fn branches(repo: &Repository, include_remote: bool) -> AppResult<BranchList> {
    let info = repo_info(repo)?;
    branch_list(repo, include_remote, info.current_branch, info.is_detached)
}

fn branch_list(
    repo: &Repository,
    include_remote: bool,
    current: Option<String>,
    is_detached: bool,
) -> AppResult<BranchList> {
    let mut local = Vec::new();
    for item in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = item?;
        let name = branch
            .name()?
            .unwrap_or_default()
            .to_string();
        let upstream = branch
            .upstream()
            .ok()
            .and_then(|up| up.name().ok().flatten().map(|n| n.to_string()));
        local.push(BranchInfo {
            is_head: branch.is_head(),
            is_remote: false,
            name,
            upstream,
        });
    }
    local.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let mut remote = Vec::new();
    if include_remote {
        let remote_names = configured_remote_names(repo);
        remote = match workdir(repo)
            .ok()
            .and_then(|root| remote_branches_from_git(root, &remote_names).ok())
        {
            Some(items) => items,
            None => {
                let mut items = Vec::new();
                for item in repo.branches(Some(BranchType::Remote))? {
                    let (branch, _) = item?;
                    let full = branch.get().name().unwrap_or_default();
                    let name = branch.name()?.unwrap_or_default();
                    let Some(name) = remote_tracking_branch_name(full, name, &remote_names) else {
                        continue;
                    };
                    items.push(BranchInfo {
                        is_head: false,
                        is_remote: true,
                        name,
                        upstream: None,
                    });
                }
                items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                items
            }
        };
    }

    Ok(BranchList {
        current,
        is_detached,
        local,
        remote,
    })
}

fn configured_remote_names(repo: &Repository) -> Vec<String> {
    repo.remotes()
        .ok()
        .map(|names| names.iter().flatten().map(str::to_string).collect())
        .unwrap_or_default()
}

fn is_remote_branch_name(name: &str, remotes: &[String]) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if lower == "head" || lower.ends_with("/head") {
        return false;
    }
    if !name.contains('/') {
        return false;
    }
    !remotes
        .iter()
        .any(|remote| name.eq_ignore_ascii_case(remote))
}

fn remote_tracking_branch_name(full_ref: &str, short_name: &str, remotes: &[String]) -> Option<String> {
    if let Some(rest) = full_ref.strip_prefix("refs/remotes/") {
        if !is_remote_branch_name(rest, remotes) {
            return None;
        }
    } else if !full_ref.is_empty() {
        return None;
    }
    if !is_remote_branch_name(short_name, remotes) {
        return None;
    }
    Some(short_name.trim().to_string())
}

fn remote_branches_from_git(root: &Path, remotes: &[String]) -> AppResult<Vec<BranchInfo>> {
    let stdout = run_git_stdout(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(symref)",
            "refs/remotes",
        ],
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let mut remote = Vec::new();
    for line in text.lines() {
        let mut fields = line.split('\0');
        let full = fields.next().unwrap_or("").trim();
        let name = fields.next().unwrap_or("").trim();
        let symref = fields.next().unwrap_or("").trim();
        if !symref.is_empty() {
            continue;
        }
        let Some(name) = remote_tracking_branch_name(full, name, remotes) else {
            continue;
        };
        remote.push(BranchInfo {
            is_head: false,
            is_remote: true,
            name,
            upstream: None,
        });
    }
    Ok(remote)
}

fn checkout_local_branch(repo: &Repository, branch: &git2::Branch<'_>) -> AppResult<()> {
    let reference = branch.get();
    let commit = reference.peel_to_commit()?;
    repo.checkout_tree(commit.as_object(), None)?;
    let refname = reference
        .name()
        .ok_or_else(|| AppError::msg("Invalid branch reference"))?;
    repo.set_head(refname)?;
    Ok(())
}

pub fn checkout_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if let Ok(branch) = repo.find_branch(name, BranchType::Local) {
        return checkout_local_branch(repo, &branch);
    }

    let remote = repo
        .find_branch(name, BranchType::Remote)
        .map_err(|_| AppError::msg(format!("Branch not found: {name}")))?;
    let local_name = name.split_once('/').map(|(_, rest)| rest).unwrap_or(name);
    if local_name.is_empty() || local_name == "HEAD" {
        return Err(AppError::msg("Cannot check out that remote ref"));
    }
    if let Ok(existing) = repo.find_branch(local_name, BranchType::Local) {
        return checkout_local_branch(repo, &existing);
    }
    let commit = remote.get().peel_to_commit()?;
    let mut local = repo.branch(local_name, &commit, false)?;
    let _ = local.set_upstream(Some(name));
    checkout_local_branch(repo, &local)
}

pub fn create_branch(
    repo: &Repository,
    name: &str,
    switch: bool,
    start: Option<&str>,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    {
        let commit = if let Some(start) = start.map(str::trim).filter(|value| !value.is_empty()) {
            peel_commit(repo, start)?
        } else {
            repo.head()
                .map_err(|_| AppError::msg("Cannot create a branch before the first commit"))?
                .peel_to_commit()?
        };
        if repo.find_branch(name, BranchType::Local).is_ok() {
            return Err(AppError::msg(format!("Branch `{name}` already exists")));
        }
        repo.branch(name, &commit, false)?;
    }
    if switch {
        checkout_branch(repo, name)?;
    }
    Ok(())
}

fn split_remote_branch(repo: &Repository, name: &str) -> AppResult<(String, String)> {
    let remotes = repo.remotes()?;
    let mut best: Option<(String, String)> = None;
    for remote in remotes.iter().flatten() {
        let prefix = format!("{remote}/");
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() || rest == "HEAD" {
            continue;
        }
        if best.as_ref().map(|(current, _)| current.len()).unwrap_or(0) < remote.len() {
            best = Some((remote.to_string(), rest.to_string()));
        }
    }
    best.ok_or_else(|| AppError::msg(format!("Not a remote branch: {name}")))
}

pub fn delete_branch(
    repo: &mut Repository,
    name: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    if repo.find_branch(name, BranchType::Local).is_ok() {
        if repo
            .head()
            .ok()
            .and_then(|head| head.shorthand().map(|current| current == name))
            .unwrap_or(false)
        {
            return Err(AppError::msg("Cannot delete the current branch"));
        }
        run_git_stdout(workdir(repo)?, &["branch", "-d", name])?;
        return snapshot(repo);
    }
    if repo.find_branch(name, BranchType::Remote).is_ok() {
        let (remote, branch) = split_remote_branch(repo, name)?;
        run_git_ok_progress(
            workdir(repo)?,
            &["push", "--progress", &remote, "--delete", &branch],
            on_progress,
        )?;
        if let Ok(mut tracking) = repo.find_branch(name, BranchType::Remote) {
            let _ = tracking.delete();
        }
        return snapshot(repo);
    }
    Err(AppError::msg(format!("Branch not found: {name}")))
}

pub fn revert_commit(repo: &mut Repository, spec: &str) -> AppResult<WorkspaceSnapshot> {
    let (oid, is_merge) = {
        let commit = peel_commit(repo, spec)?;
        (commit.id().to_string(), commit.parent_count() > 1)
    };
    ensure_clean_for_replay(repo)?;
    let root = workdir(repo)?;
    let result = if is_merge {
        run_git_stdout(root, &["revert", "--no-edit", "-m", "1", &oid])
    } else {
        run_git_stdout(root, &["revert", "--no-edit", &oid])
    };
    if let Err(err) = result {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn reset_to_commit(
    repo: &mut Repository,
    spec: &str,
    mode: &str,
) -> AppResult<WorkspaceSnapshot> {
    let flag = reset_flag(mode)?;
    let oid = peel_commit(repo, spec)?.id();
    ensure_reset_target(repo, oid)?;
    let oid = oid.to_string();
    run_git_stdout(workdir(repo)?, &["reset", flag, &oid])?;
    snapshot(repo)
}

fn reset_flag(mode: &str) -> AppResult<&'static str> {
    match mode.trim() {
        "soft" => Ok("--soft"),
        "mixed" => Ok("--mixed"),
        "hard" => Ok("--hard"),
        "merge" => Ok("--merge"),
        "keep" => Ok("--keep"),
        _ => Err(AppError::msg(
            "Choose a reset mode: soft, mixed, hard, merge, or keep",
        )),
    }
}

fn ensure_reset_target(repo: &Repository, _target: Oid) -> AppResult<()> {
    let head = repo
        .head()
        .map_err(|_| AppError::msg("Reset needs a checked-out branch"))?;
    if !head.is_branch() {
        return Err(AppError::msg(
            "Reset is only available on the current local branch",
        ));
    }
    Ok(())
}

pub fn cherry_pick_commit(repo: &mut Repository, spec: &str) -> AppResult<WorkspaceSnapshot> {
    let (oid, is_merge) = {
        let commit = peel_commit(repo, spec)?;
        (commit.id().to_string(), commit.parent_count() > 1)
    };
    ensure_clean_for_replay(repo)?;
    let root = workdir(repo)?;
    let result = if is_merge {
        run_git_stdout(root, &["cherry-pick", "-m", "1", &oid])
    } else {
        run_git_stdout(root, &["cherry-pick", &oid])
    };
    if let Err(err) = result {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn rebase_plan(repo: &Repository, onto: &str) -> AppResult<Vec<RebaseCommit>> {
    ensure_rebase_ready(repo)?;
    let onto_id = peel_commit(repo, onto)?.id().to_string();
    commits_to_replay(repo, &onto_id)
}

pub fn rebase_onto(repo: &mut Repository, onto: &str) -> AppResult<WorkspaceSnapshot> {
    ensure_rebase_ready(repo)?;
    let onto_id = peel_commit(repo, onto)?.id().to_string();
    let commits = commits_to_replay(repo, &onto_id)?;
    if commits.is_empty() {
        return Err(AppError::msg("Already up to date"));
    }
    let root = workdir(repo)?.to_path_buf();
    if let Err(err) = run_git_stdout(&root, &["rebase", &onto_id]) {
        return Err(rebase_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn rebase_interactive(
    repo: &mut Repository,
    onto: &str,
    steps: &[RebaseStep],
) -> AppResult<WorkspaceSnapshot> {
    ensure_rebase_ready(repo)?;
    let onto_id = peel_commit(repo, onto)?.id().to_string();
    let commits = commits_to_replay(repo, &onto_id)?;
    if commits.is_empty() {
        return Err(AppError::msg("Nothing to rebase"));
    }
    let todo = rebase_todo(&commits, steps)?;
    let root = workdir(repo)?.to_path_buf();
    let scratch = rebase_scratch_dir()?;
    let result = run_interactive_rebase(&root, &onto_id, &scratch, &todo);
    let _ = fs::remove_dir_all(&scratch);
    if let Err(err) = result {
        return Err(rebase_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn rebase_continue(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    rebase_control(repo, "--continue")
}

pub fn rebase_skip(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    rebase_control(repo, "--skip")
}

pub fn rebase_abort(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    rebase_control(repo, "--abort")
}

pub fn merge_ref(repo: &mut Repository, spec: &str) -> AppResult<WorkspaceSnapshot> {
    ensure_merge_ready(repo)?;
    let target = peel_commit(repo, spec)?.id().to_string();
    let root = workdir(repo)?.to_path_buf();
    if let Err(err) = run_git_stdout(&root, &["merge", "--no-edit", &target]) {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn operation_continue(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    let kind = git_operation(repo)
        .ok_or_else(|| AppError::msg("No merge, rebase, cherry-pick, or revert is in progress"))?
        .kind;
    let flag = match kind.as_str() {
        "rebase" => "rebase",
        "merge" => "merge",
        "cherry-pick" => "cherry-pick",
        "revert" => "revert",
        _ => return Err(AppError::msg("No operation is in progress")),
    };
    run_operation(repo, &[flag, "--continue"])
}

pub fn operation_abort(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    let kind = git_operation(repo)
        .ok_or_else(|| AppError::msg("No merge, rebase, cherry-pick, or revert is in progress"))?
        .kind;
    let flag = match kind.as_str() {
        "rebase" => "rebase",
        "merge" => "merge",
        "cherry-pick" => "cherry-pick",
        "revert" => "revert",
        _ => return Err(AppError::msg("No operation is in progress")),
    };
    run_operation(repo, &[flag, "--abort"])
}

pub fn resolve_conflict(repo: &mut Repository, path: &str, side: &str) -> AppResult<WorkspaceSnapshot> {
    if git_operation(repo).is_none() {
        return Err(AppError::msg("No conflicted operation is in progress"));
    }
    let path = to_git_path(path);
    if path.is_empty() {
        return Err(AppError::msg("A file path is required"));
    }
    let root = workdir(repo)?.to_path_buf();
    match side.trim() {
        "ours" => run_git_stdout(&root, &["checkout", "--ours", "--", &path])?,
        "theirs" => run_git_stdout(&root, &["checkout", "--theirs", "--", &path])?,
        "both" => resolve_both_sides(&root, &path)?,
        _ => {
            return Err(AppError::msg(
                "Choose a side: ours, theirs, or both",
            ))
        }
    };
    run_git_stdout(&root, &["add", "--", &path])?;
    snapshot(repo)
}

fn resolve_both_sides(root: &Path, path: &str) -> AppResult<Vec<u8>> {
    let file = root.join(path);
    let text = fs::read_to_string(&file).map_err(|_| {
        AppError::msg("This conflict has no text markers. Choose current or incoming.")
    })?;
    let resolved = take_both_sides(&text).ok_or_else(|| {
        AppError::msg("This conflict has no text markers. Choose current or incoming.")
    })?;
    fs::write(&file, resolved)?;
    Ok(Vec::new())
}

fn take_both_sides(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    let mut found = false;
    while let Some(start) = rest.find("<<<<<<<") {
        found = true;
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let line_end = after.find('\n').unwrap_or(after.len());
        let body = &after[line_end + usize::from(line_end < after.len())..];
        let mid = body.find("\n=======")?;
        let mut ours = &body[..mid];
        if let Some(base_at) = ours.find("\n|||||||") {
            ours = &ours[..base_at];
        }
        let after_mid = &body[mid + 1..];
        let marker_end = after_mid.find('\n').unwrap_or(after_mid.len());
        let theirs_and_rest = &after_mid[marker_end + usize::from(marker_end < after_mid.len())..];
        let end = theirs_and_rest.find(">>>>>>>")?;
        let theirs = &theirs_and_rest[..end];
        out.push_str(ours);
        if !ours.ends_with('\n') && !theirs.is_empty() {
            out.push('\n');
        }
        out.push_str(theirs);
        let after_end = &theirs_and_rest[end..];
        let end_line = after_end.find('\n').map(|index| index + 1).unwrap_or(after_end.len());
        rest = &after_end[end_line..];
    }
    if !found {
        return None;
    }
    out.push_str(rest);
    Some(out)
}

fn run_operation(repo: &mut Repository, args: &[&str]) -> AppResult<WorkspaceSnapshot> {
    let root = workdir(repo)?.to_path_buf();
    let scratch = rebase_scratch_dir()?;
    let editor = noop_editor(&scratch)?;
    let result = run_git_env(&root, args, &[("GIT_EDITOR", editor.as_str())]);
    let _ = fs::remove_dir_all(&scratch);
    match result {
        Ok(output) if output.status.success() => snapshot(repo),
        Ok(output) => Err(operation_stop_error(repo, git_output_error(output))),
        Err(err) => Err(operation_stop_error(repo, err)),
    }
}

fn ensure_merge_ready(repo: &Repository) -> AppResult<()> {
    if git_operation(repo).is_some() {
        return Err(AppError::msg("Finish or abort the current operation first"));
    }
    let head = repo
        .head()
        .map_err(|_| AppError::msg("Merge needs a checked-out branch"))?;
    if !head.is_branch() {
        return Err(AppError::msg("Merge needs a checked-out branch"));
    }
    ensure_clean_for_replay(repo)
}

fn rebase_control(repo: &mut Repository, flag: &str) -> AppResult<WorkspaceSnapshot> {
    if rebase_progress(repo).is_none() {
        return Err(AppError::msg("No rebase is in progress"));
    }
    let root = workdir(repo)?.to_path_buf();
    let scratch = rebase_scratch_dir()?;
    let editor = noop_editor(&scratch)?;
    let result = run_git_env(
        &root,
        &["rebase", flag],
        &[("GIT_EDITOR", editor.as_str())],
    );
    let _ = fs::remove_dir_all(&scratch);
    match result {
        Ok(output) if output.status.success() => snapshot(repo),
        Ok(output) => Err(rebase_stop_error(repo, git_output_error(output))),
        Err(err) => Err(rebase_stop_error(repo, err)),
    }
}

fn commits_to_replay(repo: &Repository, onto: &str) -> AppResult<Vec<RebaseCommit>> {
    let spec = format!("{onto}..HEAD");
    let bytes = run_git_stdout(
        workdir(repo)?,
        &["rev-list", "--reverse", "--no-merges", &spec],
    )?;
    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&bytes).lines() {
        let id = line.trim();
        if id.is_empty() {
            continue;
        }
        let commit = peel_commit(repo, id)?;
        let summary = commit.summary().unwrap_or("").trim().to_string();
        commits.push(RebaseCommit {
            id: commit.id().to_string(),
            short_id: short_id(&commit.id().to_string()),
            summary,
        });
    }
    Ok(commits)
}

fn rebase_todo(commits: &[RebaseCommit], steps: &[RebaseStep]) -> AppResult<RebaseTodo> {
    if steps.len() != commits.len() {
        return Err(AppError::msg(
            "The rebase plan does not match the commits on this branch",
        ));
    }
    let mut seen = HashSet::new();
    let mut lines = Vec::new();
    let mut messages = Vec::new();
    for step in steps {
        let action = step.action.trim().to_ascii_lowercase();
        if !matches!(action.as_str(), "pick" | "reword" | "squash" | "fixup" | "drop") {
            return Err(AppError::msg(format!("Unknown rebase action: {action}")));
        }
        if matches!(action.as_str(), "squash" | "fixup")
            && !lines.iter().any(|line: &String| !line.starts_with("drop "))
        {
            return Err(AppError::msg(
                "Squash and fixup need a picked or reworded commit before them",
            ));
        }
        let id = step.id.trim();
        if !seen.insert(id.to_string()) {
            return Err(AppError::msg("Each commit can appear only once"));
        }
        let commit = commits
            .iter()
            .find(|commit| commit.id == id)
            .ok_or_else(|| AppError::msg("The rebase plan includes a commit outside this range"))?;
        let subject = commit.summary.replace(['\r', '\n'], " ");
        lines.push(format!("{action} {id} {subject}"));
        if matches!(action.as_str(), "reword" | "squash") {
            let message = step.message.trim();
            if message.is_empty() {
                return Err(AppError::msg("Reword and squash need a commit message"));
            }
            messages.push(message.to_string());
        }
    }
    if seen.len() != commits.len() {
        return Err(AppError::msg(
            "The rebase plan does not match the commits on this branch",
        ));
    }
    if lines.iter().all(|line| line.starts_with("drop ")) {
        return Err(AppError::msg("Dropping every commit leaves nothing to rebase"));
    }
    Ok(RebaseTodo { lines, messages })
}

struct RebaseTodo {
    lines: Vec<String>,
    messages: Vec<String>,
}

fn run_interactive_rebase(
    root: &Path,
    onto: &str,
    scratch: &Path,
    todo: &RebaseTodo,
) -> AppResult<()> {
    let sequence = sequence_editor(scratch, &todo.lines)?;
    let message = message_editor(scratch, &todo.messages)?;
    let output = run_git_env(
        root,
        &["rebase", "-i", onto],
        &[
            ("GIT_SEQUENCE_EDITOR", sequence.as_str()),
            ("GIT_EDITOR", message.as_str()),
        ],
    )?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_output_error(output))
}

fn rebase_scratch_dir() -> AppResult<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "rebasely-rebase-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn sequence_editor(scratch: &Path, lines: &[String]) -> AppResult<String> {
    let todo = scratch.join("todo");
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(&todo, body)?;
    write_copy_editor(scratch, "sequence-editor", &todo)
}

fn message_editor(scratch: &Path, messages: &[String]) -> AppResult<String> {
    for (index, message) in messages.iter().enumerate() {
        let mut body = message.trim().to_string();
        body.push('\n');
        fs::write(scratch.join(format!("msg-{index}")), body)?;
    }
    fs::write(scratch.join("counter"), "0")?;
    if cfg!(windows) {
        let script = scratch.join("message-editor.ps1");
        let dir = scratch.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!(
                "$dest = $args[$args.Length - 1]\n$dir = '{dir}'\n$n = [int](Get-Content -LiteralPath (Join-Path $dir 'counter'))\n$src = Join-Path $dir (\"msg-$n\")\nif (Test-Path -LiteralPath $src) {{ Copy-Item -LiteralPath $src -Destination $dest -Force }}\nSet-Content -LiteralPath (Join-Path $dir 'counter') -Value ($n + 1) -NoNewline\nexit 0\n"
            ),
        )?;
        Ok(format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ))
    } else {
        let script = scratch.join("message-editor");
        fs::write(
            &script,
            "#!/bin/sh\ndir=$(dirname \"$0\")\nn=$(cat \"$dir/counter\")\nif [ -f \"$dir/msg-$n\" ]; then cp \"$dir/msg-$n\" \"$1\"; fi\necho $((n + 1)) > \"$dir/counter\"\nexit 0\n",
        )?;
        make_executable(&script)?;
        Ok(script.to_string_lossy().into_owned())
    }
}

fn noop_editor(scratch: &Path) -> AppResult<String> {
    if cfg!(windows) {
        let script = scratch.join("noop-editor.ps1");
        fs::write(&script, "exit 0\n")?;
        Ok(format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ))
    } else {
        let script = scratch.join("noop-editor");
        fs::write(&script, "#!/bin/sh\nexit 0\n")?;
        make_executable(&script)?;
        Ok(script.to_string_lossy().into_owned())
    }
}

fn write_copy_editor(scratch: &Path, name: &str, source: &Path) -> AppResult<String> {
    if cfg!(windows) {
        let script = scratch.join(format!("{name}.ps1"));
        let from = source.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!(
                "$dest = $args[$args.Length - 1]\nCopy-Item -LiteralPath '{from}' -Destination $dest -Force\nexit 0\n"
            ),
        )?;
        Ok(format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ))
    } else {
        let script = scratch.join(name);
        let from = source.to_string_lossy().replace('\'', "'\\''");
        fs::write(
            &script,
            format!("#!/bin/sh\ncp '{from}' \"$1\"\nexit 0\n"),
        )?;
        make_executable(&script)?;
        Ok(script.to_string_lossy().into_owned())
    }
}

fn make_executable(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }
    let _ = path;
    Ok(())
}

fn rebase_progress(repo: &Repository) -> Option<RebaseProgress> {
    let git_dir = repo.path();
    let dir = ["rebase-merge", "rebase-apply"]
        .into_iter()
        .map(|name| git_dir.join(name))
        .find(|path| path.is_dir())?;
    let read = |name: &str| {
        fs::read_to_string(dir.join(name))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(RebaseProgress {
        onto: read("onto"),
        head_name: read("head-name").map(|name| {
            name.trim_start_matches("refs/heads/")
                .trim_start_matches("refs/remotes/")
                .to_string()
        }),
        step: read("msgnum").and_then(|value| value.parse().ok()),
        total: read("end").and_then(|value| value.parse().ok()),
    })
}

fn git_operation(repo: &Repository) -> Option<GitOperation> {
    if let Some(rebase) = rebase_progress(repo) {
        return Some(GitOperation {
            kind: "rebase".to_string(),
            head_name: rebase.head_name,
            onto: rebase.onto,
            step: rebase.step,
            total: rebase.total,
        });
    }
    let git_dir = repo.path();
    let marker = [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .into_iter()
    .find(|(name, _)| git_dir.join(name).is_file())?;
    let onto = fs::read_to_string(git_dir.join(marker.0))
        .ok()
        .map(|value| value.trim().chars().take(7).collect())
        .filter(|value: &String| !value.is_empty());
    Some(GitOperation {
        kind: marker.1.to_string(),
        head_name: None,
        onto,
        step: None,
        total: None,
    })
}

fn ensure_rebase_ready(repo: &Repository) -> AppResult<()> {
    if git_operation(repo).is_some() {
        return Err(AppError::msg("Finish or abort the current operation first"));
    }
    let head = repo
        .head()
        .map_err(|_| AppError::msg("Rebase needs a checked-out branch"))?;
    if !head.is_branch() {
        return Err(AppError::msg("Rebase needs a checked-out branch"));
    }
    ensure_clean_for_replay(repo)
}

fn rebase_stop_error(repo: &Repository, err: AppError) -> AppError {
    operation_stop_error(repo, err)
}

fn operation_stop_error(repo: &Repository, err: AppError) -> AppError {
    let Some(operation) = git_operation(repo) else {
        return err;
    };
    let name = match operation.kind.as_str() {
        "merge" => "Merge",
        "cherry-pick" => "Cherry-pick",
        "revert" => "Revert",
        _ => "Rebase",
    };
    AppError::msg(format!(
        "{name} stopped with conflicts. Resolve them on Changes, then continue or abort.\n{err}"
    ))
}

fn git_output_error(output: std::process::Output) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    AppError::msg(if message.is_empty() {
        "Git command failed".to_string()
    } else {
        message
    })
}

fn short_id(id: &str) -> String {
    id.chars().take(7).collect()
}

pub fn write_commit_patch(repo: &Repository, spec: &str, dest: &str) -> AppResult<()> {
    let oid = peel_commit(repo, spec)?.id().to_string();
    let dest = dest.trim();
    if dest.is_empty() {
        return Err(AppError::msg("A patch path is required"));
    }
    let bytes = run_git_stdout(workdir(repo)?, &["format-patch", "-1", "--stdout", &oid])?;
    if bytes.is_empty() {
        return Err(AppError::msg("Git produced an empty patch"));
    }
    fs::write(dest, bytes)?;
    Ok(())
}

pub fn apply_patch(repo: &mut Repository, patch_path: &str) -> AppResult<WorkspaceSnapshot> {
    let path = PathBuf::from(patch_path.trim());
    if !path.is_file() {
        return Err(AppError::msg("Patch file was not found"));
    }
    let bytes = fs::read(&path)?;
    if bytes.is_empty() {
        return Err(AppError::msg("Patch file is empty"));
    }
    let root = workdir(repo)?;
    let path = path.to_string_lossy().into_owned();
    if looks_like_mbox(&bytes) {
        ensure_clean_for_replay(repo)?;
        run_git_stdout(root, &["am", "--3way", &path])?;
    } else {
        run_git_stdout(root, &["apply", "--3way", "--", &path])?;
    }
    snapshot(repo)
}

fn looks_like_mbox(bytes: &[u8]) -> bool {
    let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]);
    let start = preview.trim_start_matches('\u{feff}');
    start.starts_with("From ") || preview.contains("\nFrom ")
}

fn peel_commit<'repo>(repo: &'repo Repository, spec: &str) -> AppResult<git2::Commit<'repo>> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(AppError::msg("Commit is required"));
    }
    Ok(repo.revparse_single(spec)?.peel_to_commit()?)
}

fn ensure_clean_for_replay(repo: &Repository) -> AppResult<()> {
    let status = status_snapshot(repo)?;
    if !status.staged.is_empty()
        || status
            .unstaged
            .iter()
            .any(|file| file.kind != "untracked")
    {
        return Err(AppError::msg("Commit or stash your changes first"));
    }
    Ok(())
}

fn cached_ahead_behind(repo: &Repository, local: Oid, upstream: Oid) -> Option<(usize, usize)> {
    struct Entry {
        local: Oid,
        upstream: Oid,
        ahead: usize,
        behind: usize,
    }
    static CACHE: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard
            .iter()
            .find(|entry| entry.local == local && entry.upstream == upstream)
        {
            return Some((hit.ahead, hit.behind));
        }
    }
    let (ahead, behind) = repo.graph_ahead_behind(local, upstream).ok()?;
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|entry| entry.local != local || entry.upstream != upstream);
        guard.push(Entry {
            local,
            upstream,
            ahead,
            behind,
        });
        if guard.len() > 8 {
            let extra = guard.len() - 8;
            guard.drain(0..extra);
        }
    }
    Some((ahead, behind))
}

fn snapshot_mutex(root: &Path) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = gates.lock().unwrap_or_else(|err| err.into_inner());
    map.entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub fn snapshot(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    let root = workdir(repo)?.to_path_buf();
    let gate = snapshot_mutex(&root);
    let _guard = gate.lock().unwrap_or_else(|err| err.into_inner());
    let status_root = root.clone();
    let status_task = thread::spawn(move || status_from_git(&status_root));
    let built: AppResult<_> = (|| {
        let info = repo_info(repo)?;
        let branches = branch_list(repo, false, info.current_branch.clone(), info.is_detached)?;
        let remotes = list_remotes(repo)?;
        let stashes = list_stashes(repo)?;
        Ok((info, branches, remotes, stashes, head_commit(repo)))
    })();
    let status_result = match status_task.join() {
        Ok(result) => result,
        Err(_) => Err(AppError::msg("Could not read status")),
    };
    let (info, branches, remotes, stashes, head) = built?;
    let status = match status_result {
        Ok(status) => status,
        Err(_) => status_from_libgit2(repo)?,
    };
    Ok(WorkspaceSnapshot {
        repo: info,
        status,
        branches,
        remotes,
        stashes,
        head_commit: head,
    })
}

fn head_commit(repo: &Repository) -> Option<CommitSummary> {
    let oid = repo.head().ok()?.target()?;
    summarize_oid(repo, oid).ok()
}

pub fn list_remotes(repo: &Repository) -> AppResult<Vec<RemoteInfo>> {
    let names = repo.remotes()?;
    let mut remotes = Vec::new();
    for name in names.iter().flatten() {
        let remote = repo.find_remote(name)?;
        remotes.push(RemoteInfo {
            name: name.to_string(),
            url: remote.url().map(str::to_string),
            push_url: remote.pushurl().map(str::to_string),
        });
    }
    remotes.sort_by(|left, right| {
        fn rank(name: &str) -> u8 {
            if name.eq_ignore_ascii_case("origin") {
                0
            } else {
                1
            }
        }
        rank(&left.name).cmp(&rank(&right.name)).then_with(|| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
        })
    });
    Ok(remotes)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    pub heads: usize,
}

pub fn probe_remote_url(repo: &Repository, url: &str) -> AppResult<RemoteProbe> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Remote URL is required"));
    }
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    command.arg("-C").arg(workdir(repo)?);
    command.args([
        "-c",
        "http.lowSpeedLimit=1000",
        "-c",
        "http.lowSpeedTime=20",
        "ls-remote",
        "--heads",
        url,
    ]);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=15");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|err| AppError::msg(err.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = [stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(AppError::msg(if message.is_empty() {
            "Could not reach this remote".to_string()
        } else {
            message
        }));
    }
    let heads = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    Ok(RemoteProbe { heads })
}

pub fn add_remote(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() || url.is_empty() {
        return Err(AppError::msg("Remote name and URL are required"));
    }
    if !is_valid_remote_name(name) {
        return Err(AppError::msg(
            "Remote name can only contain letters, numbers, dots, hyphens, and underscores",
        ));
    }
    if repo.find_remote(name).is_ok() {
        return Err(AppError::msg(format!("Remote `{name}` already exists")));
    }
    repo.remote(name, url)?;
    Ok(())
}

fn is_valid_remote_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.starts_with('-') || name.ends_with('.')
    {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn set_remote_url(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Remote URL is required"));
    }
    repo.remote_set_url(name, url)?;
    Ok(())
}

pub fn delete_remote(repo: &Repository, name: &str) -> AppResult<()> {
    repo.remote_delete(name)?;
    Ok(())
}

pub fn list_stashes(repo: &mut Repository) -> AppResult<Vec<StashInfo>> {
    let mut stashes = Vec::new();
    repo.stash_foreach(|index, message, id| {
        stashes.push(StashInfo {
            index,
            message: message.to_string(),
            id: id.to_string(),
        });
        true
    })?;
    Ok(stashes)
}

pub fn stash_save(repo: &mut Repository, message: &str, include_untracked: bool) -> AppResult<()> {
    let signature = repo
        .signature()
        .map_err(|_| AppError::msg("Set user.name and user.email in Settings before stashing"))?;
    let mut flags = git2::StashFlags::DEFAULT;
    if include_untracked {
        flags |= git2::StashFlags::INCLUDE_UNTRACKED;
    }
    let message = message.trim();
    let message = if message.is_empty() { "WIP" } else { message };
    repo.stash_save(&signature, message, Some(flags))?;
    Ok(())
}

pub fn stash_apply(repo: &mut Repository, index: usize) -> AppResult<()> {
    repo.stash_apply(index, None)?;
    Ok(())
}

pub fn stash_pop(repo: &mut Repository, index: usize) -> AppResult<()> {
    repo.stash_pop(index, None)?;
    Ok(())
}

pub fn stash_drop(repo: &mut Repository, index: usize) -> AppResult<()> {
    repo.stash_drop(index)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDetails {
    pub id: String,
    pub message: String,
    pub files: Vec<CommitFile>,
}

pub fn stash_details(repo: &Repository, oid: &str) -> AppResult<StashDetails> {
    let oid = oid.trim();
    let parsed = Oid::from_str(oid)?;
    let commit = repo.find_commit(parsed)?;
    let mut files = commit_files_from_git2(repo, parsed)?;
    // Parent 0 is HEAD, parent 1 is the index, parent 2 is untracked files.
    if commit.parent_count() > 2 {
        if let Ok(untracked) = commit.parent(2) {
            for file in untracked_stash_files(repo, &untracked)? {
                if files.iter().any(|existing| existing.path == file.path) {
                    continue;
                }
                files.push(file);
            }
        }
    }
    files.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    Ok(StashDetails {
        id: parsed.to_string(),
        message: commit.summary().unwrap_or("").trim().to_string(),
        files,
    })
}

pub fn stash_file_diff(repo: &Repository, oid: &str, path: &str) -> AppResult<FileDiff> {
    let parsed = Oid::from_str(oid.trim())?;
    let commit = repo.find_commit(parsed)?;
    let tracked = commit_file_diff(repo, oid, path)?;
    if tracked.binary || !tracked.lines.is_empty() {
        return Ok(tracked);
    }
    if commit.parent_count() > 2 {
        if let Ok(untracked) = commit.parent(2) {
            let tree = untracked.tree()?;
            let rel = to_git_path(path);
            let mut opts = diff_options_for(&rel, false);
            let diff = repo.diff_tree_to_tree(None, Some(&tree), Some(&mut opts))?;
            let file_diff = collect_patch(diff, &rel)?;
            if file_diff.binary || !file_diff.lines.is_empty() {
                return Ok(file_diff);
            }
        }
    }
    Ok(tracked)
}

fn untracked_stash_files(repo: &Repository, commit: &git2::Commit<'_>) -> AppResult<Vec<CommitFile>> {
    let tree = commit.tree()?;
    let mut opts = DiffOptions::new();
    opts.skip_binary_check(true);
    let diff = repo.diff_tree_to_tree(None, Some(&tree), Some(&mut opts))?;
    let mut files = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|item| item.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if path.is_empty() {
                return true;
            }
            files.push(CommitFile {
                binary: looks_binary_path(&path),
                path,
                old_path: None,
                kind: "untracked".to_string(),
            });
            true
        },
        None,
        None,
        None,
    )?;
    Ok(files)
}

pub fn read_git_identity() -> AppResult<GitIdentity> {
    let cfg = git2::Config::open_default().ok();
    Ok(GitIdentity {
        name: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.name").ok())
            .unwrap_or_default(),
        email: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.email").ok())
            .unwrap_or_default(),
    })
}

fn global_gitconfig_path() -> AppResult<PathBuf> {
    if let Ok(path) = git2::Config::find_global() {
        return Ok(path);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| AppError::msg("Could not resolve home directory"))?;
    Ok(PathBuf::from(home).join(".gitconfig"))
}

pub fn write_git_identity(name: &str, email: &str) -> AppResult<()> {
    write_identity_to_config(&global_gitconfig_path()?, name, email)
}

fn local_gitconfig_path(repo: &Repository) -> PathBuf {
    repo.path().join("config")
}

pub fn read_local_git_identity(repo: &Repository) -> AppResult<GitIdentity> {
    let path = local_gitconfig_path(repo);
    let cfg = git2::Config::open(&path).ok();
    Ok(GitIdentity {
        name: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.name").ok())
            .unwrap_or_default(),
        email: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.email").ok())
            .unwrap_or_default(),
    })
}

pub fn write_local_git_identity(repo: &Repository, name: &str, email: &str) -> AppResult<()> {
    write_identity_to_config(&local_gitconfig_path(repo), name, email)
}

fn write_identity_to_config(path: &Path, name: &str, email: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !path.exists() {
        fs::write(path, "")?;
    }
    let mut cfg = git2::Config::open(path)?;
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() {
        let _ = cfg.remove("user.name");
    } else {
        cfg.set_str("user.name", name)?;
    }
    if email.is_empty() {
        let _ = cfg.remove("user.email");
    } else {
        cfg.set_str("user.email", email)?;
    }
    Ok(())
}

pub fn open_in_file_manager(path: &str) -> AppResult<()> {
    let path = strip_verbatim_prefix(path);
    let mut command = if cfg!(windows) {
        let mut command = Command::new("explorer");
        command.arg(&path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };
    command
        .spawn()
        .map_err(|err| AppError::msg(format!("Could not open folder: {err}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> (PathBuf, Repository) {
        let root = std::env::temp_dir().join(format!(
            "rebasely-stash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Rebasely Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        (root, repo)
    }

    #[test]
    fn stash_diff_includes_tracked_and_untracked_files() {
        let (root, mut repo) = temp_repo();
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        fs::write(root.join("gone.txt"), "remove me\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.add_path(Path::new("gone.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        drop(index);
        {
            let tree = repo.find_tree(tree_id).unwrap();
            let signature = repo.signature().unwrap();
            repo.commit(Some("HEAD"), &signature, &signature, "init", &tree, &[])
                .unwrap();
        }

        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();
        fs::write(root.join("extra.txt"), "new\n").unwrap();
        stash_save(&mut repo, "wip", true).unwrap();

        let mut id = String::new();
        repo.stash_foreach(|index, _, oid| {
            if index == 0 {
                id = oid.to_string();
            }
            true
        })
        .unwrap();

        let details = stash_details(&repo, &id).unwrap();
        let kind = |path: &str| {
            details
                .files
                .iter()
                .find(|file| file.path == path)
                .map(|file| file.kind.as_str())
        };
        assert_eq!(kind("tracked.txt"), Some("modified"), "{:?}", details.files);
        assert_eq!(kind("gone.txt"), Some("deleted"), "{:?}", details.files);
        assert_eq!(kind("extra.txt"), Some("untracked"), "{:?}", details.files);

        let tracked = stash_file_diff(&repo, &id, "tracked.txt").unwrap();
        assert!(tracked.lines.iter().any(|line| line.content.contains("changed")));
        let extra = stash_file_diff(&repo, &id, "extra.txt").unwrap();
        assert!(
            extra
                .lines
                .iter()
                .any(|line| line.kind == "add" && line.content.contains("new")),
            "{:?}",
            extra.lines
        );

        let _ = fs::remove_dir_all(&root);
    }

    fn commit_file(repo: &mut Repository, root: &Path, name: &str, body: &str, message: &str) {
        fs::write(root.join(name), body).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        drop(index);
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .unwrap();
    }

    fn head_summary(repo: &Repository) -> String {
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .summary()
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn rebase_onto_replays_commits() {
        let (root, mut repo) = temp_repo();
        commit_file(&mut repo, &root, "base.txt", "base\n", "base");
        repo.branch("feature", &repo.head().unwrap().peel_to_commit().unwrap(), false)
            .unwrap();
        commit_file(&mut repo, &root, "main.txt", "main\n", "main-tip");
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        commit_file(&mut repo, &root, "feature.txt", "one\n", "feature-one");
        commit_file(&mut repo, &root, "feature.txt", "two\n", "feature-two");

        let onto = {
            let main = repo
                .find_branch("main", BranchType::Local)
                .or_else(|_| repo.find_branch("master", BranchType::Local))
                .unwrap();
            main.get().target().unwrap().to_string()
        };
        rebase_onto(&mut repo, &onto).unwrap();
        assert_eq!(head_summary(&repo), "feature-two");
        assert!(root.join("main.txt").exists());
        assert!(rebase_progress(&repo).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn interactive_rebase_can_reword_and_drop() {
        let (root, mut repo) = temp_repo();
        commit_file(&mut repo, &root, "file.txt", "a\n", "base");
        let onto = repo.head().unwrap().target().unwrap().to_string();
        commit_file(&mut repo, &root, "file.txt", "b\n", "keep");
        let keep = repo.head().unwrap().target().unwrap().to_string();
        commit_file(&mut repo, &root, "file.txt", "c\n", "change-me");
        let change = repo.head().unwrap().target().unwrap().to_string();
        commit_file(&mut repo, &root, "file.txt", "d\n", "drop-me");
        let drop = repo.head().unwrap().target().unwrap().to_string();

        rebase_interactive(
            &mut repo,
            &onto,
            &[
                RebaseStep {
                    id: keep,
                    action: "pick".to_string(),
                    message: String::new(),
                },
                RebaseStep {
                    id: change,
                    action: "reword".to_string(),
                    message: "rewritten".to_string(),
                },
                RebaseStep {
                    id: drop,
                    action: "drop".to_string(),
                    message: String::new(),
                },
            ],
        )
        .unwrap();
        assert_eq!(head_summary(&repo), "rewritten");
        let log = run_git_stdout(&root, &["log", "--format=%s"]).unwrap();
        let text = String::from_utf8_lossy(&log);
        assert!(text.contains("keep"));
        assert!(!text.contains("drop-me"));
        assert!(!text.contains("change-me"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rebase_conflict_can_abort() {
        let (root, mut repo) = temp_repo();
        commit_file(&mut repo, &root, "file.txt", "base\n", "base");
        repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "left\n", "left");
        repo.set_head("refs/heads/other").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "right\n", "right");
        let original = repo.head().unwrap().target().unwrap();
        let onto = {
            let main = repo
                .find_branch("main", BranchType::Local)
                .or_else(|_| repo.find_branch("master", BranchType::Local))
                .unwrap();
            main.get().target().unwrap().to_string()
        };
        let err = rebase_onto(&mut repo, &onto).unwrap_err();
        assert!(err.to_string().contains("conflicts"), "{err}");
        assert!(rebase_progress(&repo).is_some());
        rebase_abort(&mut repo).unwrap();
        assert!(rebase_progress(&repo).is_none());
        assert_eq!(repo.head().unwrap().target().unwrap(), original);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rebase_conflict_can_continue() {
        let (root, mut repo) = temp_repo();
        commit_file(&mut repo, &root, "file.txt", "base\n", "base");
        repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "left\n", "left");
        repo.set_head("refs/heads/other").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "right\n", "right");
        let onto = {
            let main = repo
                .find_branch("main", BranchType::Local)
                .or_else(|_| repo.find_branch("master", BranchType::Local))
                .unwrap();
            main.get().target().unwrap().to_string()
        };
        assert!(rebase_onto(&mut repo, &onto).is_err());
        fs::write(root.join("file.txt"), "both\n").unwrap();
        run_git_stdout(&root, &["add", "file.txt"]).unwrap();
        rebase_continue(&mut repo).unwrap();
        assert!(rebase_progress(&repo).is_none());
        assert_eq!(head_summary(&repo), "right");
        assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "both\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reset_can_move_to_a_commit_on_another_branch() {
        let (root, mut repo) = temp_repo();
        commit_file(&mut repo, &root, "file.txt", "base\n", "base");
        let current = repo.head().unwrap().name().unwrap().to_string();
        repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "left\n", "left");
        let other_tip = {
            repo.set_head("refs/heads/other").unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .unwrap();
            commit_file(&mut repo, &root, "other.txt", "side\n", "side");
            let tip = repo.head().unwrap().target().unwrap();
            repo.set_head(&current).unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .unwrap();
            tip
        };
        reset_to_commit(&mut repo, &other_tip.to_string(), "hard").unwrap();
        assert_eq!(repo.head().unwrap().target().unwrap(), other_tip);
        assert_eq!(head_summary(&repo), "side");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_conflict_can_take_ours_and_continue() {
        let (root, mut repo) = temp_repo();
        commit_file(&mut repo, &root, "file.txt", "base\n", "base");
        repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "left\n", "left");
        let incoming = repo.head().unwrap().target().unwrap().to_string();
        repo.set_head("refs/heads/other").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        commit_file(&mut repo, &root, "file.txt", "right\n", "right");
        assert!(merge_ref(&mut repo, &incoming).unwrap_err().to_string().contains("conflicts"));
        assert_eq!(git_operation(&repo).unwrap().kind, "merge");
        resolve_conflict(&mut repo, "file.txt", "ours").unwrap();
        operation_continue(&mut repo).unwrap();
        assert!(git_operation(&repo).is_none());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap().replace("\r\n", "\n"),
            "right\n"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
