use super::*;

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

fn top_stash(repo: &mut Repository) -> Option<Oid> {
    let mut top = None;
    let _ = repo.stash_foreach(|_, _, oid| {
        top = Some(*oid);
        false
    });
    top
}

/// Stashing goes through `git stash` so clean and smudge filters such as Git LFS
/// run on the way in and out. An empty `paths` stashes every change.
pub fn stash_save(
    repo: &mut Repository,
    message: &str,
    include_untracked: bool,
    paths: &[String],
) -> AppResult<()> {
    repo.signature()
        .map_err(|_| AppError::msg("Set user.name and user.email in Settings before stashing"))?;
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
    let target = Oid::from_str(id.trim())?;
    let mut found = None;
    repo.stash_foreach(|index, _, oid| {
        if *oid == target {
            found = Some(index);
            return false;
        }
        true
    })?;
    found.ok_or_else(|| AppError::msg("That stash no longer exists"))
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
    files.sort_by_cached_key(|file| file.path.to_lowercase());
    Ok(StashDetails {
        id: parsed.to_string(),
        message: commit.summary().unwrap_or("").trim().to_string(),
        files,
    })
}

pub fn stash_file_diff(
    repo: &Repository,
    oid: &str,
    path: &str,
    ignore_whitespace: bool,
) -> AppResult<FileDiff> {
    let parsed = Oid::from_str(oid.trim())?;
    let commit = repo.find_commit(parsed)?;
    let tracked = commit_file_diff(repo, oid, path, ignore_whitespace)?;
    if tracked.binary || !tracked.lines.is_empty() {
        return Ok(tracked);
    }
    if commit.parent_count() > 2 {
        if let Ok(untracked) = commit.parent(2) {
            let tree = untracked.tree()?;
            let rel = to_git_path(path);
            let mut opts = view_options_for(&rel, false, ignore_whitespace);
            let diff = repo.diff_tree_to_tree(None, Some(&tree), Some(&mut opts))?;
            let file_diff = collect_patch(diff, &rel)?;
            if file_diff.binary || !file_diff.lines.is_empty() {
                return Ok(file_diff);
            }
        }
    }
    Ok(tracked)
}

pub(super) fn untracked_stash_files(repo: &Repository, commit: &git2::Commit<'_>) -> AppResult<Vec<CommitFile>> {
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
