use super::*;

pub fn list_stashes(repo: &mut Repository) -> AppResult<Vec<StashInfo>> {
    let output = run_git(workdir(repo)?, &["stash", "list", "--format=%H%x1f%gs"])?;
    if !output.status.success() {
        return Err(git_output_error(output));
    }
    let mut stashes = Vec::new();
    for (index, line) in String::from_utf8_lossy(&output.stdout).lines().enumerate() {
        let Some((id, message)) = line.split_once('\u{1f}') else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        stashes.push(StashInfo {
            index,
            message: message.to_string(),
            id: id.to_string(),
        });
    }
    Ok(stashes)
}

fn top_stash(repo: &Repository) -> Option<String> {
    rev_parse(repo, "refs/stash")
}

/// Stashing goes through `git stash` so clean and smudge filters such as Git LFS
/// run on the way in and out. An empty `paths` stashes every change.
pub fn stash_save(
    repo: &mut Repository,
    message: &str,
    include_untracked: bool,
    paths: &[String],
) -> AppResult<()> {
    if !identity_configured(repo) {
        return Err(AppError::msg(
            "Set user.name and user.email in Settings before stashing",
        ));
    }
    let message = message.trim();
    let message = if message.is_empty() { "WIP" } else { message };
    let before = top_stash(repo);
    let mut args = vec!["stash", "push", "--message", message];
    if include_untracked {
        args.push("--include-untracked");
    }
    let root = workdir_owned(repo)?;
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if specs.is_empty() {
        run_git_stdout(&root, &args)?;
    } else {
        run_git_pathspecs(&root, &args, &specs)?;
    }
    // `git stash push` exits cleanly when there is nothing to save.
    if top_stash(repo) == before {
        return Err(AppError::msg("No local changes to stash"));
    }
    Ok(())
}

/// Stash indexes shift whenever another stash is pushed or dropped, so callers
/// name a stash by its commit id and it is looked up right before use.
fn stash_index(repo: &mut Repository, id: &str) -> AppResult<usize> {
    let target = id.trim();
    list_stashes(repo)?
        .into_iter()
        .find(|stash| stash.id == target)
        .map(|stash| stash.index)
        .ok_or_else(|| AppError::msg("That stash no longer exists"))
}

fn run_stash(repo: &mut Repository, action: &str, id: &str) -> AppResult<()> {
    let index = stash_index(repo, id)?;
    let spec = format!("stash@{{{index}}}");
    run_git_stdout(&workdir_owned(repo)?, &["stash", action, &spec])?;
    Ok(())
}

pub fn stash_apply(repo: &mut Repository, id: &str) -> AppResult<()> {
    run_stash(repo, "apply", id)
}

pub fn stash_pop(repo: &mut Repository, id: &str) -> AppResult<()> {
    run_stash(repo, "pop", id)
}

pub fn stash_drop(repo: &mut Repository, id: &str) -> AppResult<()> {
    let index = stash_index(repo, id)?;
    let spec = format!("stash@{{{index}}}");
    run_git_stdout(workdir(repo)?, &["stash", "drop", &spec])?;
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
    let info = commit_info(repo, oid)?;
    let root = workdir(repo)?;
    let mut files = commit_files_from_git(root, &info.id)?;
    // Parent 0 is HEAD, parent 1 is the index, parent 2 is untracked files.
    if let Some(untracked) = info.parents.get(2) {
        for mut file in commit_files_from_git(root, untracked)? {
            file.kind = "untracked".to_string();
            file.old_path = None;
            if files.iter().any(|existing| existing.path == file.path) {
                continue;
            }
            files.push(file);
        }
    }
    files.sort_by_cached_key(|file| file.path.to_lowercase());
    Ok(StashDetails {
        id: info.id,
        message: info.summary.trim().to_string(),
        files,
    })
}

pub fn stash_file_diff(
    repo: &Repository,
    oid: &str,
    path: &str,
    ignore_whitespace: bool,
) -> AppResult<FileDiff> {
    let info = commit_info(repo, oid)?;
    let tracked = commit_file_diff(repo, &info.id, path, ignore_whitespace)?;
    if tracked.binary || !tracked.lines.is_empty() {
        return Ok(tracked);
    }
    if let Some(untracked) = info.parents.get(2) {
        let file_diff = diff_between(repo, EMPTY_TREE, untracked, path, ignore_whitespace)?;
        if file_diff.binary || !file_diff.lines.is_empty() {
            return Ok(file_diff);
        }
    }
    Ok(tracked)
}
