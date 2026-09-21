use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use git2::build::CheckoutBuilder;
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
                            if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
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
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    run_git_ok_progress(workdir(repo)?, &["fetch", "--progress"], on_progress)?;
    snapshot(repo)
}

pub fn pull_remote(
    repo: &mut Repository,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    run_git_ok_progress(workdir(repo)?, &["pull", "--progress"], on_progress)?;
    snapshot(repo)
}

pub fn push_remote(
    repo: &mut Repository,
    force: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let mut args = vec!["push", "--progress"];
    if force {
        args.insert(1, "--force-with-lease");
    }
    run_git_ok_progress(workdir(repo)?, &args, on_progress)?;
    snapshot(repo)
}

fn run_git(root: &Path, args: &[&str]) -> AppResult<std::process::Output> {
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
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

fn run_git_ok_progress(
    root: &Path,
    args: &[&str],
    mut on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
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
                let mut builder = CheckoutBuilder::new();
                builder.force().path(&rel);
                repo.checkout_head(Some(&mut builder))?;
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
    })
}

pub fn commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: Option<&str>,
) -> AppResult<Vec<CommitSummary>> {
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    if let Some(query) = query {
        return search_commits(repo, limit, skip, query);
    }
    if let Ok(root) = workdir(repo) {
        let n = format!("-n{limit}");
        let s = format!("--skip={skip}");
        if let Ok(stdout) = run_git_stdout(
            root,
            &[
                "-c",
                "log.showSignature=false",
                "log",
                &n,
                &s,
                "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P",
            ],
        ) {
            let mut items = parse_git_log(&stdout)?;
            decorate_commits(repo, &mut items);
            return Ok(items);
        }
    }
    let mut items = commits_from_revwalk(repo, limit, skip)?;
    decorate_commits(repo, &mut items);
    Ok(items)
}

fn search_commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: &str,
) -> AppResult<Vec<CommitSummary>> {
    let needle = query.to_lowercase();
    let labels = collect_ref_labels(repo);
    let mut items = Vec::new();
    let mut skipped = 0usize;

    if let Ok(root) = workdir(repo) {
        let mut child = spawn_git_stdout(
            root,
            &[
                "-c",
                "log.showSignature=false",
                "-c",
                "i18n.logOutputEncoding=utf-8",
                "log",
                "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P",
            ],
        )?;
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
) -> AppResult<Vec<CommitSummary>> {
    let mut revwalk = repo.revwalk()?;
    match repo.head() {
        Ok(head) => {
            if let Some(oid) = head.target() {
                revwalk.push(oid)?;
            } else {
                return Ok(Vec::new());
            }
        }
        Err(err) if err.code() == ErrorCode::UnbornBranch => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    }
    revwalk.set_sorting(Sort::NONE)?;

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
        });
    }
    Ok(items)
}

fn decorate_commits(repo: &Repository, commits: &mut [CommitSummary]) {
    let labels = collect_ref_labels(repo);
    apply_ref_labels(commits, &labels);
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
    if let Ok(root) = workdir(repo) {
        if let Ok(stdout) = run_git_stdout(
            root,
            &[
                "for-each-ref",
                "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%00%(refname)%00%(HEAD)",
                "refs/heads",
                "refs/tags",
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
        if content.ends_with('\r') {
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
        let mut content = line.to_string();
        if content.ends_with('\r') {
            content.pop();
        }
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
        remote = match workdir(repo).ok().and_then(|root| remote_branches_from_git(root).ok()) {
            Some(items) => items,
            None => {
                let mut items = Vec::new();
                for item in repo.branches(Some(BranchType::Remote))? {
                    let (branch, _) = item?;
                    let name = branch.name()?.unwrap_or_default().to_string();
                    if name.is_empty() || name.ends_with("/HEAD") {
                        continue;
                    }
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
        current: info.current_branch,
        is_detached: info.is_detached,
        local,
        remote,
    })
}

fn remote_branches_from_git(root: &Path) -> AppResult<Vec<BranchInfo>> {
    let stdout = run_git_stdout(
        root,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let mut remote = Vec::new();
    for line in text.lines() {
        let name = line.trim();
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        remote.push(BranchInfo {
            is_head: false,
            is_remote: true,
            name: name.to_string(),
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

pub fn create_branch(repo: &Repository, name: &str, switch: bool) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    let commit = repo
        .head()
        .map_err(|_| AppError::msg("Cannot create a branch before the first commit"))?
        .peel_to_commit()?;
    repo.branch(name, &commit, false)?;
    if switch {
        checkout_branch(repo, name)?;
    }
    Ok(())
}

pub fn snapshot(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    Ok(WorkspaceSnapshot {
        repo: repo_info(repo)?,
        status: status_snapshot(repo)?,
        branches: branches(repo, false)?,
        remotes: list_remotes(repo)?,
        stashes: list_stashes(repo)?,
        head_commit: head_commit(repo),
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
    remotes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(remotes)
}

pub fn add_remote(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() || url.is_empty() {
        return Err(AppError::msg("Remote name and URL are required"));
    }
    repo.remote(name, url)?;
    Ok(())
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
