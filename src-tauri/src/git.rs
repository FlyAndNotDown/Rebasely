use std::fs;
use std::path::{Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, DiffFindOptions, DiffFormat, DiffOptions, ErrorCode, IndexAddOption, ObjectType,
    Oid, Repository, Sort, Status, StatusOptions,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub repo: RepoInfo,
    pub status: StatusSnapshot,
    pub branches: BranchList,
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
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo.statuses(Some(&mut opts))?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_ignored() {
            continue;
        }

        let path = entry
            .path()
            .unwrap_or_default()
            .replace('\\', "/");
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

        let wt_flags = Status::WT_NEW
            | Status::WT_MODIFIED
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

pub fn commit(repo: &Repository, message: &str) -> AppResult<CommitSummary> {
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
    })
}

pub fn commits(repo: &Repository, limit: usize) -> AppResult<Vec<CommitSummary>> {
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
    revwalk.set_sorting(Sort::TIME)?;

    let mut items = Vec::new();
    for oid in revwalk.take(limit) {
        items.push(summarize_oid(repo, oid?)?);
    }
    Ok(items)
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

fn diff_options_for(path: &str) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .minimal(true);
    opts
}

pub fn workdir_diff(repo: &Repository, path: &str, staged: bool) -> AppResult<FileDiff> {
    let rel = to_git_path(path);
    let mut opts = diff_options_for(&rel);
    let mut diff = if staged {
        let head_tree = match repo.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(err) if err.code() == ErrorCode::UnbornBranch => None,
            Err(err) => return Err(err.into()),
        };
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };
    let _ = diff.find_similar(Some(&mut DiffFindOptions::new()));
    collect_patch(diff, &rel)
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
    let oid = Oid::from_str(oid)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    let _ = diff.find_similar(Some(&mut DiffFindOptions::new()));

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
                binary: is_delta_binary(&delta) || looks_binary_path(&path),
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

    Ok(CommitDetails {
        commit: summarize_oid(repo, oid)?,
        files,
    })
}

pub fn commit_file_diff(repo: &Repository, oid: &str, path: &str) -> AppResult<FileDiff> {
    let oid = Oid::from_str(oid)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };
    let rel = to_git_path(path);
    let mut opts = diff_options_for(&rel);
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    let _ = diff.find_similar(Some(&mut DiffFindOptions::new()));
    collect_patch(diff, &rel)
}

pub fn branches(repo: &Repository) -> AppResult<BranchList> {
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
    Ok(BranchList {
        current: info.current_branch,
        is_detached: info.is_detached,
        local,
    })
}

pub fn checkout_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let branch = repo.find_branch(name, BranchType::Local)?;
    let reference = branch.get();
    let commit = reference.peel_to_commit()?;
    repo.checkout_tree(commit.as_object(), None)?;
    let refname = reference
        .name()
        .ok_or_else(|| AppError::msg("Invalid branch reference"))?;
    repo.set_head(refname)?;
    Ok(())
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

pub fn snapshot(repo: &Repository) -> AppResult<WorkspaceSnapshot> {
    Ok(WorkspaceSnapshot {
        repo: repo_info(repo)?,
        status: status_snapshot(repo)?,
        branches: branches(repo)?,
    })
}
