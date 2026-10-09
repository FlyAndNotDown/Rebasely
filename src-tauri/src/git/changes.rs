use super::*;

/// Staging goes through `git add` so clean filters such as Git LFS run; libgit2
/// would store the raw file instead of the pointer.
pub fn stage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    run_git_pathspecs(workdir(repo)?, &["add", "--all"], &specs)?;
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

pub(super) fn is_untracked(status: Status) -> bool {
    status.is_wt_new()
        && !status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        )
}

pub(super) fn remove_worktree_path(full: &Path) -> AppResult<()> {
    if full.is_dir() {
        fs::remove_dir_all(full)?;
    } else if full.exists() {
        fs::remove_file(full)?;
    }
    Ok(())
}

/// Git on Windows cannot overwrite a read-only file. Elsewhere it replaces the
/// file, and clearing the flag would make it world-writable.
pub(super) fn clear_readonly(full: &Path) -> AppResult<()> {
    if !cfg!(windows) || !full.is_file() {
        return Ok(());
    }
    let mut perms = fs::metadata(full)?.permissions();
    if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(full, perms)?;
    }
    Ok(())
}

pub fn discard_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let head = match repo.head() {
        Ok(head) => Some(head.peel(ObjectType::Commit)?),
        Err(err) if err.code() == ErrorCode::UnbornBranch => None,
        Err(err) => return Err(err.into()),
    };
    let head_tree = head
        .as_ref()
        .map(|object| object.peel_to_tree())
        .transpose()?;

    let mut in_head = Vec::new();
    let mut not_in_head = Vec::new();
    for raw in paths {
        let rel = to_git_path(raw);
        if rel.is_empty() {
            continue;
        }
        let full = ensure_inside_workdir(repo, &rel)?;
        if repo
            .status_file(Path::new(&rel))
            .ok()
            .is_some_and(is_untracked)
        {
            remove_worktree_path(&full)?;
            continue;
        }
        if head_tree
            .as_ref()
            .is_some_and(|tree| tree.get_path(Path::new(&rel)).is_ok())
        {
            clear_readonly(&full)?;
            in_head.push(rel);
        } else {
            not_in_head.push((rel, full));
        }
    }

    if !not_in_head.is_empty() {
        match &head {
            Some(object) => {
                repo.reset_default(Some(object), not_in_head.iter().map(|(rel, _)| rel))?;
            }
            None => {
                let mut index = repo.index()?;
                for (rel, _) in &not_in_head {
                    let _ = index.remove_path(Path::new(rel));
                }
                index.write()?;
            }
        }
        for (_, full) in &not_in_head {
            remove_worktree_path(full)?;
        }
    }

    // `git checkout` resets the index entry too, and applies the same filters as
    // `git status`. Writing the raw blob turns a clean CRLF worktree into LF,
    // which stays listed with an empty diff.
    let root = workdir(repo)?;
    for chunk in pathspec_chunks(&in_head) {
        let mut args = vec!["--literal-pathspecs", "checkout", "HEAD", "--"];
        args.extend(chunk.iter().map(String::as_str));
        run_git_stdout(root, &args)?;
    }
    Ok(())
}

/// Splits paths so each git invocation stays under the Windows command-line limit.
pub(super) fn pathspec_chunks(paths: &[String]) -> Vec<&[String]> {
    const MAX_CHARS: usize = 24_000;
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut length = 0;
    for (index, path) in paths.iter().enumerate() {
        if index > start && length + path.len() + 3 > MAX_CHARS {
            chunks.push(&paths[start..index]);
            start = index;
            length = 0;
        }
        length += path.len() + 3;
    }
    if start < paths.len() {
        chunks.push(&paths[start..]);
    }
    chunks
}

/// Appends patterns to the top-level .gitignore, skipping ones it already lists
/// and keeping the file's line endings.
pub fn ignore_patterns(repo: &Repository, patterns: &[String]) -> AppResult<()> {
    let path = workdir(repo)?.join(".gitignore");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut listed: HashSet<String> = existing
        .lines()
        .map(|line| line.trim().to_string())
        .collect();
    let mut text = existing.clone();
    for pattern in patterns.iter().map(|pattern| pattern.trim()) {
        if pattern.is_empty() || !listed.insert(pattern.to_string()) {
            continue;
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push_str(newline);
        }
        text.push_str(pattern);
        text.push_str(newline);
    }
    if text != existing {
        fs::write(&path, text)?;
    }
    Ok(())
}

/// Commits through `git commit` so hooks, signing, and an in-progress merge or
/// cherry-pick (its extra parent and original author) are all honoured.
pub fn commit(repo: &Repository, message: &str, amend: bool) -> AppResult<CommitSummary> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::msg("Commit message cannot be empty"));
    }

    repo.signature().map_err(|_| {
        AppError::msg("Set user.name and user.email in Git config before committing")
    })?;

    let head = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?),
        Err(err) if err.code() == ErrorCode::UnbornBranch => None,
        Err(err) => return Err(err.into()),
    };
    if amend && head.is_none() {
        return Err(AppError::msg("Nothing to amend"));
    }
    // A merge may legitimately record the same tree as HEAD.
    if !amend && git_operation(repo).is_none() {
        let mut index = repo.index()?;
        index.read(false)?;
        let unchanged = match &head {
            Some(parent) => parent.tree_id() == index.write_tree()?,
            None => index.is_empty(),
        };
        if unchanged {
            return Err(AppError::msg("Nothing to commit"));
        }
    }

    let mut args = vec!["commit", "--file=-"];
    if amend {
        args.push("--amend");
    }
    run_git_input(workdir(repo)?, &args, message.as_bytes())?;
    let oid = repo
        .head()?
        .target()
        .ok_or_else(|| AppError::msg("Commit did not move HEAD"))?;
    summarize_oid(repo, oid)
}
