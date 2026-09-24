use super::*;

pub(super) fn is_delta_binary(delta: &git2::DiffDelta<'_>) -> bool {
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

pub(super) fn collect_patch(diff: git2::Diff<'_>, fallback_path: &str) -> AppResult<FileDiff> {
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
    // Returning false stops libgit2 from generating the rest of the patch.
    let print_result = diff.print(DiffFormat::Patch, |_, _, line| {
        if binary || truncated {
            return false;
        }
        if matches!(line.origin(), 'B') || line.content().contains(&0) {
            binary = true;
            lines.clear();
            return false;
        }
        if hunk_or_meta_only(line.origin()) && matches!(line.origin(), 'F' | 'G' | 'I' | 'B') {
            let content = String::from_utf8_lossy(line.content());
            if content.to_ascii_lowercase().contains("binary") {
                binary = true;
                lines.clear();
                return false;
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
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            return false;
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

pub(super) fn hunk_or_meta_only(origin: char) -> bool {
    matches!(origin, 'F' | 'G' | 'I' | 'B' | 'H')
}

pub(super) fn diff_options_for(path: &str, include_untracked: bool) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.pathspec(path);
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

pub(super) fn untracked_workdir_diff(repo: &Repository, path: &str) -> AppResult<Option<FileDiff>> {
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
    let (bytes, cut) = read_text_prefix(&abs)?;
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
    let mut truncated = cut;
    for (index, line) in text.split('\n').enumerate() {
        if lines.len() >= MAX_DIFF_LINES {
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

pub(super) fn delta_kind(delta: git2::Delta) -> &'static str {
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

pub(super) fn commit_files_from_git(root: &Path, oid: &str) -> AppResult<Vec<CommitFile>> {
    let stdout = run_git_stdout(
        root,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "--no-renames",
            "--root",
            "--diff-merges=first-parent",
            "-z",
            oid,
        ],
    )?;
    parse_name_status_z(&stdout)
}

pub(super) fn parse_name_status_z(bytes: &[u8]) -> AppResult<Vec<CommitFile>> {
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

pub(super) fn commit_files_from_git2(repo: &Repository, oid: Oid) -> AppResult<Vec<CommitFile>> {
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

pub fn compare_files(repo: &Repository, base: &str, head: &str) -> AppResult<Vec<CommitFile>> {
    let base = base.trim();
    let head = head.trim();
    if base.is_empty() || head.is_empty() {
        return Err(AppError::msg("Two revisions are required"));
    }
    let base_commit = peel_commit(repo, base)?;
    let head_commit = peel_commit(repo, head)?;
    if let Ok(root) = workdir(repo) {
        if let Ok(files) = compare_files_from_git(root, base, head) {
            return Ok(files);
        }
    }
    compare_files_from_git2(repo, &base_commit, &head_commit)
}

pub(super) fn compare_files_from_git(root: &Path, base: &str, head: &str) -> AppResult<Vec<CommitFile>> {
    let stdout = run_git_stdout(
        root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            base,
            head,
        ],
    )?;
    parse_name_status_z(&stdout)
}

pub(super) fn compare_files_from_git2(
    repo: &Repository,
    base: &git2::Commit<'_>,
    head: &git2::Commit<'_>,
) -> AppResult<Vec<CommitFile>> {
    let base_tree = base.tree()?;
    let head_tree = head.tree()?;
    let mut opts = DiffOptions::new();
    opts.skip_binary_check(true);
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    let mut files = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|item| item.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let old_path = delta
                .old_file()
                .path()
                .map(|item| item.to_string_lossy().replace('\\', "/"))
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

pub fn compare_file_diff(
    repo: &Repository,
    base: &str,
    head: &str,
    path: &str,
) -> AppResult<FileDiff> {
    let base_tree = peel_commit(repo, base.trim())?.tree()?;
    let head_tree = peel_commit(repo, head.trim())?.tree()?;
    let rel = to_git_path(path);
    let mut opts = diff_options_for(&rel, false);
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    collect_patch(diff, &rel)
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
