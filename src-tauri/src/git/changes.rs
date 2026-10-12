use super::*;

/// Staging goes through `git add` so clean filters such as Git LFS store a
/// pointer instead of the file contents.
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
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    let root = workdir(repo)?;
    if head_oid(repo).is_some() {
        run_git_pathspecs(root, &["reset", "-q", "HEAD"], &specs)?;
    } else {
        run_git_pathspecs(root, &["rm", "-q", "--cached", "--ignore-unmatch"], &specs)?;
    }
    Ok(())
}

pub(super) fn is_untracked(repo: &Repository, rel: &str) -> bool {
    let Ok(output) = run_git(
        repo.workdir(),
        &["status", "--porcelain=v1", "-z", "--ignored=no", "--", rel],
    ) else {
        return false;
    };
    output.status.success() && output.stdout.starts_with(b"??")
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
    let has_head = head_oid(repo).is_some();
    let mut in_head = Vec::new();
    let mut not_in_head = Vec::new();
    for raw in paths {
        let rel = to_git_path(raw);
        if rel.is_empty() {
            continue;
        }
        let full = ensure_inside_workdir(repo, &rel)?;
        if is_untracked(repo, &rel) {
            remove_worktree_path(&full)?;
            continue;
        }
        if has_head && object_exists(repo, &format!("HEAD:{rel}")) {
            clear_readonly(&full)?;
            in_head.push(rel);
        } else {
            not_in_head.push((rel, full));
        }
    }

    if !not_in_head.is_empty() {
        let specs: Vec<String> = not_in_head.iter().map(|(rel, _)| rel.clone()).collect();
        let root = workdir(repo)?;
        if has_head {
            run_git_pathspecs(root, &["reset", "-q", "HEAD"], &specs)?;
        } else {
            run_git_pathspecs(root, &["rm", "-q", "--cached", "--ignore-unmatch"], &specs)?;
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

    if !identity_configured(repo) {
        return Err(AppError::msg(
            "Set user.name and user.email in Git config before committing",
        ));
    }

    let head = head_oid(repo);
    if amend && head.is_none() {
        return Err(AppError::msg("Nothing to amend"));
    }
    // A merge may legitimately record the same tree as HEAD.
    if !amend && git_operation(repo).is_none() && index_matches_head(repo)? {
        return Err(AppError::msg("Nothing to commit"));
    }

    let mut args = vec!["commit", "--file=-"];
    if amend {
        args.push("--amend");
    }
    run_git_input(workdir(repo)?, &args, message.as_bytes())?;
    let oid = head_oid(repo).ok_or_else(|| AppError::msg("Commit did not move HEAD"))?;
    summarize_oid(repo, &oid)
}
