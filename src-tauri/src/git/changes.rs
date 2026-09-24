use super::*;

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
    let head_tree = head.as_ref().map(|object| object.peel_to_tree()).transpose()?;

    let mut in_head = Vec::new();
    let mut not_in_head = Vec::new();
    for raw in paths {
        let rel = to_git_path(raw);
        if rel.is_empty() {
            continue;
        }
        let full = ensure_inside_workdir(repo, &rel)?;
        if repo.status_file(Path::new(&rel)).ok().is_some_and(is_untracked) {
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
            None,
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
