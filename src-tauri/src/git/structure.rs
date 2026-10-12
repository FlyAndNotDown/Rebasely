use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub path: String,
    pub url: Option<String>,
    /// "clean", "uninitialized", "modified" (checked out at another commit than
    /// recorded), or "conflicted".
    pub state: String,
    pub commit: Option<String>,
}

/// Parses `git submodule status`: a state flag, the commit, the path, and an
/// optional `(describe)` suffix.
pub(super) fn parse_submodule_status(text: &str) -> Vec<(String, String, String)> {
    let mut items = Vec::new();
    for line in text.lines() {
        let Some(flag) = line.chars().next() else {
            continue;
        };
        let rest = &line[flag.len_utf8()..];
        let Some((commit, after)) = rest.split_once(' ') else {
            continue;
        };
        let path = match after.rfind(" (") {
            Some(index) if after.ends_with(')') => &after[..index],
            _ => after,
        };
        let state = match flag {
            '-' => "uninitialized",
            '+' => "modified",
            'U' => "conflicted",
            _ => "clean",
        };
        items.push((
            state.to_string(),
            commit.to_string(),
            path.replace('\\', "/"),
        ));
    }
    items
}

pub fn list_submodules(repo: &Repository) -> AppResult<Vec<SubmoduleInfo>> {
    let root = workdir(repo)?;
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let urls = submodule_urls(repo);
    let stdout = run_git_stdout(root, &["-c", "core.quotePath=off", "submodule", "status"])?;
    Ok(parse_submodule_status(&String::from_utf8_lossy(&stdout))
        .into_iter()
        .map(|(state, commit, path)| SubmoduleInfo {
            url: urls.get(&path).cloned(),
            commit: Some(commit).filter(|commit| !commit.is_empty()),
            state,
            path,
        })
        .collect())
}

fn submodule_urls(repo: &Repository) -> HashMap<String, String> {
    let Ok(stdout) = run_git_stdout(
        repo.workdir(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "--get-regexp",
            r"^submodule\.",
        ],
    ) else {
        return HashMap::new();
    };
    let mut paths = HashMap::new();
    let mut urls = HashMap::new();
    for line in String::from_utf8_lossy(&stdout).lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let Some(name) = key.strip_prefix("submodule.") else {
            continue;
        };
        if let Some(name) = name.strip_suffix(".path") {
            paths.insert(name.to_string(), value.replace('\\', "/"));
        } else if let Some(name) = name.strip_suffix(".url") {
            urls.insert(name.to_string(), value.to_string());
        }
    }
    paths
        .into_iter()
        .filter_map(|(name, path)| urls.get(&name).map(|url| (path, url.clone())))
        .collect()
}

/// Initializes and checks out submodules at their recorded commits, nested
/// ones included. An empty `paths` updates them all.
pub fn update_submodules(
    repo: &mut Repository,
    paths: &[String],
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let mut args = vec!["submodule", "update", "--init", "--recursive", "--progress"];
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if !specs.is_empty() {
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
    }
    run_git_ok_progress(workdir(repo)?, &args, on_progress)?;
    snapshot(repo)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` would remove the entry.
    pub prunable: bool,
    /// The worktree this repository was opened from.
    pub current: bool,
    /// The repository's main working tree.
    pub main: bool,
}

pub(super) fn parse_worktree_list(text: &str) -> Vec<WorktreeInfo> {
    let mut items = Vec::new();
    for (index, record) in text
        .split("\n\n")
        .filter(|record| !record.trim().is_empty())
        .enumerate()
    {
        let mut item = WorktreeInfo {
            path: String::new(),
            head: None,
            branch: None,
            detached: false,
            locked: false,
            prunable: false,
            current: false,
            main: index == 0,
        };
        for line in record.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => item.path = value.to_string(),
                "HEAD" => item.head = Some(value.to_string()),
                "branch" => item.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                "detached" => item.detached = true,
                "locked" => item.locked = true,
                "prunable" => item.prunable = true,
                _ => {}
            }
        }
        if !item.path.is_empty() {
            items.push(item);
        }
    }
    items
}

fn same_folder(left: &str, right: &Path) -> bool {
    let left = Path::new(left);
    let left = strip_verbatim_path(left.canonicalize().unwrap_or_else(|_| left.to_path_buf()));
    let right = strip_verbatim_path(right.canonicalize().unwrap_or_else(|_| right.to_path_buf()));
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

pub fn list_worktrees(repo: &Repository) -> AppResult<Vec<WorktreeInfo>> {
    let root = workdir_owned(repo)?;
    let stdout = run_git_stdout(&root, &["worktree", "list", "--porcelain"])?;
    let mut items = parse_worktree_list(&String::from_utf8_lossy(&stdout).replace("\r\n", "\n"));
    for item in &mut items {
        item.current = same_folder(&item.path, &root);
    }
    Ok(items)
}

/// Creates a worktree at `path`, checking out `branch`, or a new branch
/// `new_branch` started from `start` (HEAD when empty).
pub fn add_worktree(
    repo: &Repository,
    path: &str,
    branch: Option<&str>,
    new_branch: Option<&str>,
    start: Option<&str>,
) -> AppResult<String> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg("Choose a folder for the worktree"));
    }
    let mut args = vec!["worktree", "add"];
    let new_branch = new_branch.map(str::trim).filter(|name| !name.is_empty());
    if let Some(name) = new_branch {
        args.extend(["-b", name]);
    }
    args.push(path);
    match (
        new_branch,
        branch.map(str::trim).filter(|name| !name.is_empty()),
    ) {
        (None, Some(branch)) => args.push(branch),
        (Some(_), _) => {
            if let Some(start) = start.map(str::trim).filter(|start| !start.is_empty()) {
                args.push(start);
            }
        }
        (None, None) => return Err(AppError::msg("Choose a branch or name a new one")),
    }
    run_git_stdout(workdir(repo)?, &args)?;
    let created = PathBuf::from(path);
    Ok(strip_verbatim_prefix(
        &created.canonicalize().unwrap_or(created).to_string_lossy(),
    ))
}

pub fn remove_worktree(repo: &Repository, path: &str, force: bool) -> AppResult<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path.trim());
    run_git_stdout(workdir(repo)?, &args)?;
    Ok(())
}

pub fn prune_worktrees(repo: &Repository) -> AppResult<()> {
    run_git_stdout(workdir(repo)?, &["worktree", "prune"])?;
    Ok(())
}
