use super::*;

pub fn branches(repo: &Repository, include_remote: bool) -> AppResult<BranchList> {
    let info = repo_info(repo)?;
    branch_list(repo, include_remote, info.current_branch, info.is_detached)
}

pub(super) fn branch_list(
    repo: &Repository,
    include_remote: bool,
    current: Option<String>,
    is_detached: bool,
) -> AppResult<BranchList> {
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
        let remote_names = configured_remote_names(repo);
        remote = match workdir(repo)
            .ok()
            .and_then(|root| remote_branches_from_git(root, &remote_names).ok())
        {
            Some(items) => items,
            None => {
                let mut items = Vec::new();
                for item in repo.branches(Some(BranchType::Remote))? {
                    let (branch, _) = item?;
                    let full = branch.get().name().unwrap_or_default();
                    let name = branch.name()?.unwrap_or_default();
                    let Some(name) = remote_tracking_branch_name(full, name, &remote_names) else {
                        continue;
                    };
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
        current,
        is_detached,
        local,
        remote,
        tags: list_tags(repo)?,
    })
}

pub(super) fn list_tags(repo: &Repository) -> AppResult<Vec<TagInfo>> {
    let mut tags = Vec::new();
    repo.tag_foreach(|_oid, name| {
        let name = String::from_utf8_lossy(name);
        if let Some(short) = name.strip_prefix("refs/tags/") {
            if !short.is_empty() {
                tags.push(TagInfo {
                    name: short.to_string(),
                });
            }
        }
        true
    })?;
    tags.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
    });
    Ok(tags)
}

pub(super) fn configured_remote_names(repo: &Repository) -> Vec<String> {
    repo.remotes()
        .ok()
        .map(|names| names.iter().flatten().map(str::to_string).collect())
        .unwrap_or_default()
}

pub(super) fn is_remote_branch_name(name: &str, remotes: &[String]) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if lower == "head" || lower.ends_with("/head") {
        return false;
    }
    if !name.contains('/') {
        return false;
    }
    !remotes
        .iter()
        .any(|remote| name.eq_ignore_ascii_case(remote))
}

pub(super) fn remote_tracking_branch_name(full_ref: &str, short_name: &str, remotes: &[String]) -> Option<String> {
    if let Some(rest) = full_ref.strip_prefix("refs/remotes/") {
        if !is_remote_branch_name(rest, remotes) {
            return None;
        }
    } else if !full_ref.is_empty() {
        return None;
    }
    if !is_remote_branch_name(short_name, remotes) {
        return None;
    }
    Some(short_name.trim().to_string())
}

pub(super) fn remote_branches_from_git(root: &Path, remotes: &[String]) -> AppResult<Vec<BranchInfo>> {
    let stdout = run_git_stdout(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(symref)",
            "refs/remotes",
        ],
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let mut remote = Vec::new();
    for line in text.lines() {
        let mut fields = line.split('\0');
        let full = fields.next().unwrap_or("").trim();
        let name = fields.next().unwrap_or("").trim();
        let symref = fields.next().unwrap_or("").trim();
        if !symref.is_empty() {
            continue;
        }
        let Some(name) = remote_tracking_branch_name(full, name, remotes) else {
            continue;
        };
        remote.push(BranchInfo {
            is_head: false,
            is_remote: true,
            name,
            upstream: None,
        });
    }
    Ok(remote)
}

pub(super) fn checkout_local_branch(repo: &Repository, branch: &git2::Branch<'_>) -> AppResult<()> {
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

    if repo.find_reference(&format!("refs/tags/{name}")).is_ok() {
        let commit = peel_commit(repo, name)?;
        repo.checkout_tree(commit.as_object(), None)?;
        repo.set_head_detached(commit.id())?;
        return Ok(());
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

pub fn create_tag(
    repo: &Repository,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() || name.ends_with('/') || name.contains("//") || name.contains([' ', '~', '^', ':', '?', '*', '[', '\\']) {
        return Err(AppError::msg("Tag name is invalid"));
    }
    let target = if let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) {
        peel_commit(repo, target)?
    } else {
        repo.head()
            .map_err(|_| AppError::msg("Cannot create a tag before the first commit"))?
            .peel_to_commit()?
    };
    if let Some(message) = message.map(str::trim).filter(|value| !value.is_empty()) {
        let signature = repo.signature()?;
        repo.tag(name, target.as_object(), &signature, message, false)?;
    } else {
        repo.tag_lightweight(name, target.as_object(), false)?;
    }
    Ok(())
}

pub fn delete_tag(repo: &Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Tag name cannot be empty"));
    }
    repo.tag_delete(name)?;
    Ok(())
}

pub fn push_tag(
    repo: &Repository,
    remote: &str,
    name: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    let remote = remote.trim();
    let name = name.trim();
    if remote.is_empty() || name.is_empty() {
        return Err(AppError::msg("A remote and tag name are required"));
    }
    let spec = format!("refs/tags/{name}");
    run_git_ok_progress(
        workdir(repo)?,
        &["push", "--progress", remote, &spec],
        on_progress,
    )?;
    Ok(())
}

pub fn create_branch(
    repo: &Repository,
    name: &str,
    switch: bool,
    start: Option<&str>,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    {
        let commit = if let Some(start) = start.map(str::trim).filter(|value| !value.is_empty()) {
            peel_commit(repo, start)?
        } else {
            repo.head()
                .map_err(|_| AppError::msg("Cannot create a branch before the first commit"))?
                .peel_to_commit()?
        };
        if repo.find_branch(name, BranchType::Local).is_ok() {
            return Err(AppError::msg(format!("Branch `{name}` already exists")));
        }
        repo.branch(name, &commit, false)?;
    }
    if switch {
        checkout_branch(repo, name)?;
    }
    Ok(())
}

pub(super) fn split_remote_branch(repo: &Repository, name: &str) -> AppResult<(String, String)> {
    let remotes = repo.remotes()?;
    let mut best: Option<(String, String)> = None;
    for remote in remotes.iter().flatten() {
        let prefix = format!("{remote}/");
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() || rest == "HEAD" {
            continue;
        }
        if best.as_ref().map(|(current, _)| current.len()).unwrap_or(0) < remote.len() {
            best = Some((remote.to_string(), rest.to_string()));
        }
    }
    best.ok_or_else(|| AppError::msg(format!("Not a remote branch: {name}")))
}

pub fn delete_branch(
    repo: &mut Repository,
    name: &str,
    force: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    if repo.find_branch(name, BranchType::Local).is_ok() {
        if repo
            .head()
            .ok()
            .and_then(|head| head.shorthand().map(|current| current == name))
            .unwrap_or(false)
        {
            return Err(AppError::msg("Cannot delete the current branch"));
        }
        let flag = if force { "-D" } else { "-d" };
        run_git_stdout(workdir(repo)?, &["branch", flag, name])?;
        return snapshot(repo);
    }
    if repo.find_branch(name, BranchType::Remote).is_ok() {
        let (remote, branch) = split_remote_branch(repo, name)?;
        run_git_ok_progress(
            workdir(repo)?,
            &["push", "--progress", &remote, "--delete", &branch],
            on_progress,
        )?;
        if let Ok(mut tracking) = repo.find_branch(name, BranchType::Remote) {
            let _ = tracking.delete();
        }
        return snapshot(repo);
    }
    Err(AppError::msg(format!("Branch not found: {name}")))
}
