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
    let stdout = run_git_stdout(
        workdir(repo)?,
        &[
            "-c",
            "core.quotePath=false",
            "for-each-ref",
            "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
        ],
    )?;
    let mut local = Vec::new();
    for line in String::from_utf8_lossy(&stdout).lines() {
        let mut fields = line.split('\0');
        let name = fields.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let upstream = fields.next().unwrap_or("").trim();
        let head = fields.next().unwrap_or("").trim();
        local.push(BranchInfo {
            is_head: head == "*",
            is_remote: false,
            name: name.to_string(),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
        });
    }
    local.sort_by_cached_key(|branch| branch.name.to_lowercase());

    let mut remote = Vec::new();
    if include_remote {
        let names = configured_remote_names(repo);
        let mut items = remote_branches_from_git(workdir(repo)?, &names)?;
        items.sort_by_cached_key(|branch| branch.name.to_lowercase());
        remote = items;
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
    let stdout = run_git_stdout(
        workdir(repo)?,
        &[
            "-c",
            "core.quotePath=false",
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/tags",
        ],
    )?;
    let mut tags = Vec::new();
    for line in String::from_utf8_lossy(&stdout).lines() {
        let name = line.trim();
        if !name.is_empty() {
            tags.push(TagInfo {
                name: name.to_string(),
            });
        }
    }
    tags.sort_by_cached_key(|tag| tag.name.to_lowercase());
    Ok(tags)
}

pub(super) fn configured_remote_names(repo: &Repository) -> Vec<String> {
    remote_names(repo).unwrap_or_default()
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

pub(super) fn remote_tracking_branch_name(
    full_ref: &str,
    short_name: &str,
    remotes: &[String],
) -> Option<String> {
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

pub(super) fn remote_branches_from_git(
    root: &Path,
    remotes: &[String],
) -> AppResult<Vec<BranchInfo>> {
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

/// Switching goes through `git switch` so smudge filters such as Git LFS,
/// sparse checkout, and the post-checkout hook all apply.
fn switch(repo: &Repository, args: &[&str]) -> AppResult<()> {
    let mut argv = vec!["switch", "--quiet"];
    argv.extend_from_slice(args);
    run_git_stdout(workdir(repo)?, &argv)?;
    Ok(())
}

pub fn checkout_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if ref_exists(repo, &format!("refs/heads/{name}")) {
        return switch(repo, &["--", name]);
    }

    let tag_ref = format!("refs/tags/{name}");
    if ref_exists(repo, &tag_ref) {
        return switch(repo, &["--detach", &tag_ref]);
    }

    if !ref_exists(repo, &format!("refs/remotes/{name}")) {
        return Err(AppError::msg(format!("Branch not found: {name}")));
    }
    let local_name = split_remote_branch(repo, name)
        .map(|(_, branch)| branch)
        .unwrap_or_else(|_| {
            name.split_once('/')
                .map(|(_, rest)| rest)
                .unwrap_or(name)
                .to_string()
        });
    if local_name.is_empty() || local_name == "HEAD" {
        return Err(AppError::msg("Cannot check out that remote ref"));
    }
    if ref_exists(repo, &format!("refs/heads/{local_name}")) {
        return switch(repo, &["--", &local_name]);
    }
    let remote_ref = format!("refs/remotes/{name}");
    switch(repo, &["--create", &local_name, "--track", &remote_ref])
}

pub fn create_tag(
    repo: &Repository,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Tag name cannot be empty"));
    }
    let target = if let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) {
        peel_commit(repo, target)?.id().to_string()
    } else {
        head_oid(repo)
            .ok_or_else(|| AppError::msg("Cannot create a tag before the first commit"))?
    };
    let root = workdir(repo)?;
    // `git tag` validates the name and honours tag.gpgSign for annotated tags.
    match message.map(str::trim).filter(|value| !value.is_empty()) {
        Some(message) => {
            if !identity_configured(repo) {
                return Err(AppError::msg(
                    "Set user.name and user.email in Git config before tagging",
                ));
            }
            run_git_input(
                root,
                &["tag", "--annotate", "--file=-", "--", name, &target],
                message.as_bytes(),
            )?;
        }
        None => {
            run_git_stdout(root, &["tag", "--", name, &target])?;
        }
    }
    Ok(())
}

pub fn delete_tag(repo: &Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Tag name cannot be empty"));
    }
    run_git_stdout(workdir(repo)?, &["tag", "-d", "--", name])?;
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
        &["push", "--progress", "--", remote, &spec],
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
    let start = if let Some(start) = start.map(str::trim).filter(|value| !value.is_empty()) {
        Some(peel_commit(repo, start)?.id().to_string())
    } else if head_oid(repo).is_none() {
        return Err(AppError::msg(
            "Cannot create a branch before the first commit",
        ));
    } else {
        None
    };
    if ref_exists(repo, &format!("refs/heads/{name}")) {
        return Err(AppError::msg(format!("Branch `{name}` already exists")));
    }
    let root = workdir(repo)?;
    if let Some(start) = &start {
        run_git_stdout(root, &["branch", "--", name, start])?;
    } else {
        run_git_stdout(root, &["branch", "--", name])?;
    }
    if switch {
        checkout_branch(repo, name)?;
    }
    Ok(())
}

pub(super) fn split_remote_branch(repo: &Repository, name: &str) -> AppResult<(String, String)> {
    let remotes = remote_names(repo)?;
    let mut best: Option<(String, String)> = None;
    for remote in &remotes {
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
    if ref_exists(repo, &format!("refs/heads/{name}")) {
        if symbolic_branch(repo).as_deref() == Some(name) {
            return Err(AppError::msg("Cannot delete the current branch"));
        }
        let flag = if force { "-D" } else { "-d" };
        run_git_stdout(workdir(repo)?, &["branch", flag, "--", name])?;
        return snapshot(repo);
    }
    if ref_exists(repo, &format!("refs/remotes/{name}")) {
        let (remote, branch) = split_remote_branch(repo, name)?;
        run_git_ok_progress(
            workdir(repo)?,
            &["push", "--progress", "--delete", "--", &remote, &branch],
            on_progress,
        )?;
        let _ = run_git_stdout(workdir(repo)?, &["branch", "-dr", "--", name]);
        return snapshot(repo);
    }
    Err(AppError::msg(format!("Branch not found: {name}")))
}
