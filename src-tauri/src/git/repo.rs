use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::{AppError, AppResult};

use super::cli::{git_output_error, require_git, run_git, run_git_input_output, run_git_stdout};
use super::strip_verbatim_prefix;

/// A non-bare repository addressed by the paths git itself reports.
///
/// Mutations and reads both go through the `git` executable, so filters, hooks,
/// and ignore rules match the command line. The struct only remembers where
/// that repository lives.
#[derive(Debug, Clone)]
pub struct Repository {
    workdir: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

impl Repository {
    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    /// The git directory. For a linked worktree this is that worktree's own
    /// directory, where `rebase-merge` and the index live.
    pub fn path(&self) -> &Path {
        &self.git_dir
    }

    pub fn commondir(&self) -> &Path {
        &self.common_dir
    }
}

#[derive(Debug, Clone)]
pub(super) struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub body: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// Read by the amend test. History rows only show the author.
    #[cfg_attr(not(test), allow(dead_code))]
    pub committer_name: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

impl CommitInfo {
    pub(super) fn id(&self) -> &str {
        &self.id
    }

    pub(super) fn parent_count(&self) -> usize {
        self.parents.len()
    }

    pub(super) fn parent_id(&self, index: usize) -> AppResult<&str> {
        self.parents
            .get(index)
            .map(String::as_str)
            .ok_or_else(|| AppError::msg("Commit has no such parent"))
    }

    pub(super) fn summary(&self) -> Option<&str> {
        if self.summary.is_empty() {
            None
        } else {
            Some(self.summary.as_str())
        }
    }
}

pub fn discover(path: &str) -> AppResult<Repository> {
    let path = strip_verbatim_prefix(path);
    require_git()?;
    open_repository(Path::new(&path)).map_err(|err| {
        if err.to_string() == "Bare repositories are not supported yet" {
            err
        } else {
            AppError::msg(format!("No Git repository found at {path}"))
        }
    })
}

pub fn open_at(path: &Path) -> AppResult<Repository> {
    let path = strip_verbatim_prefix(&path.to_string_lossy());
    open_repository(Path::new(&path))
}

fn open_repository(path: &Path) -> AppResult<Repository> {
    let start = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    let bare = run_git(start, &["rev-parse", "--is-bare-repository"])?;
    if !bare.status.success() {
        return Err(git_output_error(bare));
    }
    if String::from_utf8_lossy(&bare.stdout).trim() == "true" {
        return Err(AppError::msg("Bare repositories are not supported yet"));
    }
    let workdir = require_git_path(start, "--show-toplevel")?;
    let git_dir = require_git_path(&workdir, "--git-dir")?;
    let common_dir = require_git_path(&workdir, "--git-common-dir")?;
    Ok(Repository {
        workdir,
        git_dir,
        common_dir,
    })
}

fn require_git_path(root: &Path, flag: &str) -> AppResult<PathBuf> {
    let absolute = ["rev-parse", "--path-format=absolute", flag];
    let plain = ["rev-parse", flag];
    for args in [absolute.as_slice(), plain.as_slice()] {
        let output = run_git(root, args)?;
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let text = text.strip_suffix('\n').unwrap_or(&text);
        #[cfg(windows)]
        let text = text.strip_suffix('\r').unwrap_or(text);
        if text.is_empty() {
            continue;
        }
        let path = PathBuf::from(strip_verbatim_prefix(text));
        return Ok(if path.is_absolute() {
            path
        } else {
            root.join(path)
        });
    }
    Err(AppError::msg("No Git repository found"))
}

pub(super) fn peel_commit(repo: &Repository, spec: &str) -> AppResult<CommitInfo> {
    commit_info(repo, spec)
}

pub(super) fn commit_info(repo: &Repository, spec: &str) -> AppResult<CommitInfo> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(AppError::msg("Commit is required"));
    }
    let stdout = run_git_stdout(
        repo.workdir(),
        &[
            "-c",
            "i18n.logOutputEncoding=utf-8",
            "-c",
            "log.showSignature=false",
            "log",
            "-1",
            "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%at%x1f%P%x1f%s%x1e%b%x1e%B",
            spec,
        ],
    )?;
    parse_commit_info(&stdout)
}

fn parse_commit_info(bytes: &[u8]) -> AppResult<CommitInfo> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end_matches(['\r', '\n']);
    let Some((head, rest)) = text.split_once('\u{1e}') else {
        return Err(AppError::msg("Could not read commit"));
    };
    let (body, message) = rest.split_once('\u{1e}').unwrap_or((rest, rest));
    let fields: Vec<&str> = head.split('\u{1f}').collect();
    if fields.len() < 7 || fields[0].len() < 7 {
        return Err(AppError::msg("Could not read commit"));
    }
    let parents = fields[5]
        .split_whitespace()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    let summary = fields[6].to_string();
    let author_name = fields[1].trim();
    Ok(CommitInfo {
        id: fields[0].to_string(),
        summary,
        body: body.trim().to_string(),
        message: message.trim().to_string(),
        author_name: if author_name.is_empty() {
            "Unknown".to_string()
        } else {
            author_name.to_string()
        },
        author_email: fields[2].trim().to_string(),
        committer_name: fields[3].trim().to_string(),
        timestamp: fields[4].trim().parse().unwrap_or(0),
        parents,
    })
}

pub(super) fn head_oid(repo: &Repository) -> Option<String> {
    rev_parse(repo, "HEAD")
}

pub(super) fn rev_parse(repo: &Repository, spec: &str) -> Option<String> {
    let output = run_git(repo.workdir(), &["rev-parse", "--verify", "--quiet", spec]).ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id.len() < 7 {
        None
    } else {
        Some(id)
    }
}

/// Short branch name when HEAD is a branch, including an unborn branch.
pub(super) fn symbolic_branch(repo: &Repository) -> Option<String> {
    let output = run_git(repo.workdir(), &["symbolic-ref", "--quiet", "HEAD"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let short = name
        .strip_prefix("refs/heads/")
        .unwrap_or(name.as_str())
        .trim();
    if short.is_empty() {
        None
    } else {
        Some(short.to_string())
    }
}

pub(super) fn ref_exists(repo: &Repository, name: &str) -> bool {
    run_git(repo.workdir(), &["show-ref", "--verify", "--quiet", name])
        .ok()
        .is_some_and(|output| output.status.success())
}

pub(super) fn remote_names(repo: &Repository) -> AppResult<Vec<String>> {
    let stdout = run_git_stdout(repo.workdir(), &["remote"])?;
    Ok(String::from_utf8_lossy(&stdout)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect())
}

pub(super) fn identity_configured(repo: &Repository) -> bool {
    let name = config_get(repo, "user.name").unwrap_or_default();
    let email = config_get(repo, "user.email").unwrap_or_default();
    !name.trim().is_empty() && !email.trim().is_empty()
}

/// Exit 0 when the index matches HEAD (or is empty on an unborn branch).
pub(super) fn index_matches_head(repo: &Repository) -> AppResult<bool> {
    let output = run_git(repo.workdir(), &["diff", "--cached", "--quiet"])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_output_error(output)),
    }
}

pub(super) fn object_exists(repo: &Repository, spec: &str) -> bool {
    run_git(repo.workdir(), &["cat-file", "-e", spec])
        .ok()
        .is_some_and(|output| output.status.success())
}

pub(super) fn cat_blob(repo: &Repository, spec: &str) -> Option<Vec<u8>> {
    let output = run_git(repo.workdir(), &["cat-file", "blob", spec]).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(output.stdout)
}

pub(super) fn config_get(repo: &Repository, key: &str) -> Option<String> {
    config_output(repo.workdir(), &["config", "--get", key])
}

pub(super) fn config_get_local(repo: &Repository, key: &str) -> Option<String> {
    config_output(repo.workdir(), &["config", "--local", "--get", key])
}

pub(super) fn config_set_local(repo: &Repository, key: &str, value: &str) -> AppResult<()> {
    run_git_stdout(repo.workdir(), &["config", "--local", key, value])?;
    Ok(())
}

pub(super) fn config_unset_local(repo: &Repository, key: &str) -> AppResult<()> {
    let _ = run_git(repo.workdir(), &["config", "--local", "--unset", key]);
    Ok(())
}

pub(super) fn config_get_global(key: &str) -> Option<String> {
    config_output(&config_cwd(), &["config", "--global", "--get", key])
}

pub(super) fn config_get_system(key: &str) -> Option<String> {
    config_output(&config_cwd(), &["config", "--system", "--get", key])
}

pub(super) fn config_set_global(key: &str, value: &str) -> AppResult<()> {
    run_git_stdout(&config_cwd(), &["config", "--global", key, value])?;
    Ok(())
}

pub(super) fn config_unset_global(key: &str) -> AppResult<()> {
    let _ = run_git(&config_cwd(), &["config", "--global", "--unset", key]);
    Ok(())
}

pub(super) fn config_get_file(path: &Path, key: &str) -> Option<String> {
    let file = path.to_string_lossy();
    config_output(
        config_file_cwd(path),
        &["config", "--file", file.as_ref(), "--get", key],
    )
}

pub(super) fn config_set_file(path: &Path, key: &str, value: &str) -> AppResult<()> {
    let file = path.to_string_lossy();
    run_git_stdout(
        config_file_cwd(path),
        &["config", "--file", file.as_ref(), key, value],
    )?;
    Ok(())
}

pub(super) fn config_unset_file(path: &Path, key: &str) -> AppResult<()> {
    let file = path.to_string_lossy();
    let _ = run_git(
        config_file_cwd(path),
        &["config", "--file", file.as_ref(), "--unset", key],
    );
    Ok(())
}

fn config_cwd() -> PathBuf {
    std::env::temp_dir()
}

fn config_file_cwd(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| parent.is_dir())
        .unwrap_or(Path::new("."))
}

fn config_output(root: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(root, args).ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Paths git's exclude rules ignore.
///
/// `--no-index` keeps a directory ignored when a file inside it was force-added.
/// Plain `check-ignore` hides that directory. Tracked paths are removed
/// afterwards, because a pattern does not hide a file git already tracks.
/// Exit code 1 (nothing ignored) is an empty set. A query matches when git
/// echoes it back, with or without a trailing slash.
pub fn ignored_queries(repo: &Repository, queries: &[String]) -> AppResult<HashSet<String>> {
    if queries.is_empty() {
        return Ok(HashSet::new());
    }
    let mut input = Vec::new();
    for query in queries {
        input.extend_from_slice(query.replace('\\', "/").as_bytes());
        input.push(0);
    }
    let output = run_git_input_output(
        repo.workdir(),
        &["check-ignore", "--no-index", "-z", "--stdin"],
        &input,
    )?;
    match output.status.code() {
        Some(0) => {}
        Some(1) => return Ok(HashSet::new()),
        _ => return Err(git_output_error(output)),
    }
    let mut reported = HashSet::new();
    for part in output.stdout.split(|byte| *byte == 0) {
        if part.is_empty() {
            continue;
        }
        reported.insert(String::from_utf8_lossy(part).replace('\\', "/"));
    }
    let tracked = tracked_paths(repo)?;
    let mut ignored = HashSet::new();
    for query in queries {
        let norm = query.replace('\\', "/");
        let trimmed = norm.trim_end_matches('/');
        if tracked.contains(&norm) || tracked.contains(trimmed) {
            continue;
        }
        if reported.contains(&norm)
            || reported.contains(trimmed)
            || reported.contains(&format!("{trimmed}/"))
        {
            ignored.insert(query.clone());
        }
    }
    Ok(ignored)
}

fn tracked_paths(repo: &Repository) -> AppResult<Arc<HashSet<String>>> {
    struct Cached {
        git_dir: PathBuf,
        stamp: u128,
        paths: Arc<HashSet<String>>,
    }
    fn index_stamp(path: &Path) -> u128 {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    }

    let git_dir = repo.path().to_path_buf();
    let stamp = index_stamp(&git_dir.join("index"));
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard.as_ref() {
            if hit.git_dir == git_dir && hit.stamp == stamp {
                return Ok(Arc::clone(&hit.paths));
            }
        }
    }

    // `ls-files` has no `--pathspec-from-file` on the Git versions we still
    // meet, so the whole index is read once and reused until it changes.
    let stdout = run_git_stdout(repo.workdir(), &["ls-files", "-z", "--full-name"])?;
    let mut paths = HashSet::new();
    for part in stdout.split(|byte| *byte == 0) {
        if part.is_empty() {
            continue;
        }
        paths.insert(String::from_utf8_lossy(part).replace('\\', "/"));
    }
    let paths = Arc::new(paths);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(Cached {
            git_dir,
            stamp,
            paths: Arc::clone(&paths),
        });
    }
    Ok(paths)
}
