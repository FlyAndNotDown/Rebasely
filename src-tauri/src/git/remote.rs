use super::*;

pub fn fetch_remote(
    repo: &mut Repository,
    remote: Option<&str>,
    all: bool,
    prune: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let mut args = vec!["fetch", "--progress"];
    if prune {
        args.push("--prune");
    }
    if all {
        args.push("--all");
    } else if let Some(name) = remote.map(str::trim).filter(|name| !name.is_empty()) {
        args.push(name);
    }
    run_git_ok_progress(workdir(repo)?, &args, on_progress)?;
    snapshot(repo)
}

pub fn delete_remote_tag(
    repo: &mut Repository,
    remote: &str,
    name: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let remote = remote.trim();
    let name = name.trim();
    if remote.is_empty() || name.is_empty() {
        return Err(AppError::msg("A remote and tag name are required"));
    }
    let spec = format!("refs/tags/{name}");
    run_git_ok_progress(
        workdir(repo)?,
        &["push", "--progress", remote, "--delete", &spec],
        on_progress,
    )?;
    snapshot(repo)
}

/// The full ref `branch` tracks on `remote`, when its upstream is on that remote.
/// It can differ from the local name, e.g. `feature` tracking `origin/feat-x`.
pub(super) fn tracked_ref_on(repo: &Repository, branch: &str, remote: &str) -> Option<String> {
    let config = repo.config().ok()?.snapshot().ok()?;
    let tracked_remote = config.get_string(&format!("branch.{branch}.remote")).ok()?;
    if tracked_remote != remote {
        return None;
    }
    config
        .get_string(&format!("branch.{branch}.merge"))
        .ok()
        .filter(|merge| !merge.is_empty())
}

pub fn pull_remote(
    repo: &mut Repository,
    remote: Option<&str>,
    rebase: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let mut args = vec![
        "pull".to_string(),
        "--progress".to_string(),
        if rebase { "--rebase" } else { "--no-rebase" }.to_string(),
    ];
    if let Some(remote) = remote.map(str::trim).filter(|name| !name.is_empty()) {
        let branch = repo_info(repo)?
            .current_branch
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::msg("Cannot pull while HEAD is detached"))?;
        let source = tracked_ref_on(repo, &branch, remote).unwrap_or(branch);
        args.push(remote.to_string());
        args.push(source);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Err(err) = run_git_ok_progress(workdir(repo)?, &arg_refs, on_progress) {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn push_remote(
    repo: &mut Repository,
    remote: Option<&str>,
    force: bool,
    set_upstream: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let branch = repo_info(repo)?
        .current_branch
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::msg("Cannot push while HEAD is detached"))?;
    let mut args = vec!["push".to_string(), "--progress".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
    }
    if set_upstream {
        args.push("--set-upstream".to_string());
    }
    if let Some(remote) = remote.map(str::trim).filter(|name| !name.is_empty()) {
        let refspec = match tracked_ref_on(repo, &branch, remote) {
            Some(target) if !set_upstream => format!("{branch}:{target}"),
            _ => branch,
        };
        args.push(remote.to_string());
        args.push(refspec);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok_progress(workdir(repo)?, &arg_refs, on_progress)?;
    snapshot(repo)
}

pub fn clone_repository(
    url: &str,
    destination: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<String> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("A repository URL is required"));
    }
    let dest = PathBuf::from(destination.trim());
    if dest.as_os_str().is_empty() {
        return Err(AppError::msg("A destination folder is required"));
    }
    let parent = dest
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| AppError::msg("A destination folder is required"))?;
    if !parent.is_dir() {
        return Err(AppError::msg("The parent folder does not exist"));
    }
    let existed = dest.exists();
    if existed {
        if !dest.is_dir() {
            return Err(AppError::msg("Destination already exists"));
        }
        let mut entries = fs::read_dir(&dest).map_err(|err| AppError::msg(err.to_string()))?;
        if entries.next().is_some() {
            return Err(AppError::msg("Destination already exists and is not empty"));
        }
    }
    let dest_arg = dest.to_string_lossy().into_owned();
    if let Err(err) = run_git_progress(
        None,
        &["clone", "--progress", "--", url, &dest_arg],
        on_progress,
    ) {
        // A killed clone cannot clean up after itself.
        if err.is_cancelled() {
            let _ = fs::remove_dir_all(&dest);
            if existed {
                let _ = fs::create_dir(&dest);
            }
        }
        return Err(err);
    }
    let canonical = dest.canonicalize().unwrap_or(dest);
    Ok(strip_verbatim_prefix(&canonical.to_string_lossy()))
}

pub fn list_remotes(repo: &Repository) -> AppResult<Vec<RemoteInfo>> {
    let names = repo.remotes()?;
    let mut remotes = Vec::new();
    for name in names.iter().flatten() {
        let remote = repo.find_remote(name)?;
        remotes.push(RemoteInfo {
            name: name.to_string(),
            url: remote.url().map(str::to_string),
            push_url: remote.pushurl().map(str::to_string),
        });
    }
    remotes.sort_by(|left, right| {
        fn rank(name: &str) -> u8 {
            if name.eq_ignore_ascii_case("origin") {
                0
            } else {
                1
            }
        }
        rank(&left.name)
            .cmp(&rank(&right.name))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(remotes)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    pub heads: usize,
}

pub fn probe_remote_url(repo: &Repository, url: &str) -> AppResult<RemoteProbe> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Remote URL is required"));
    }
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
    let mut command = Command::new(git);
    command.arg("-C").arg(workdir(repo)?);
    command.args([
        "-c",
        "http.lowSpeedLimit=1000",
        "-c",
        "http.lowSpeedTime=20",
        "ls-remote",
        "--heads",
        url,
    ]);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env(
        "GIT_SSH_COMMAND",
        "ssh -o BatchMode=yes -o ConnectTimeout=15",
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|err| AppError::msg(err.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = [stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(AppError::msg(if message.is_empty() {
            "Could not reach this remote".to_string()
        } else {
            message
        }));
    }
    let heads = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    Ok(RemoteProbe { heads })
}

pub fn add_remote(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() || url.is_empty() {
        return Err(AppError::msg("Remote name and URL are required"));
    }
    if !is_valid_remote_name(name) {
        return Err(AppError::msg(
            "Remote name can only contain letters, numbers, dots, hyphens, and underscores",
        ));
    }
    if repo.find_remote(name).is_ok() {
        return Err(AppError::msg(format!("Remote `{name}` already exists")));
    }
    repo.remote(name, url)?;
    Ok(())
}

pub(super) fn is_valid_remote_name(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('-')
        || name.ends_with('.')
    {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn set_remote_url(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Remote URL is required"));
    }
    repo.remote_set_url(name, url)?;
    Ok(())
}

pub fn delete_remote(repo: &Repository, name: &str) -> AppResult<()> {
    repo.remote_delete(name)?;
    Ok(())
}
