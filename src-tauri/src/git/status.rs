use super::*;

pub fn repo_info(repo: &Repository) -> AppResult<RepoInfo> {
    let path = canonical_workdir(repo)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository")
        .to_string();

    let branch = symbolic_branch(repo);
    let head = head_oid(repo);
    let is_detached = branch.is_none() && head.is_some();
    let current_branch = if is_detached {
        Some("HEAD".to_string())
    } else {
        branch.clone()
    };
    let head_id = head.clone();
    let (ahead, behind, upstream) = if branch.is_some() && head.is_some() {
        match (head.as_deref(), rev_parse(repo, "@{upstream}")) {
            (Some(local), Some(upstream_oid)) => {
                let name = upstream_name(repo);
                match cached_ahead_behind(repo, local, &upstream_oid) {
                    Some((a, b)) => (Some(a), Some(b), name),
                    None => (None, None, name),
                }
            }
            _ => (None, None, None),
        }
    } else {
        (None, None, None)
    };

    Ok(RepoInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        current_branch,
        head_id,
        is_detached,
        ahead,
        behind,
        upstream,
        rebase: rebase_progress(repo),
        operation: git_operation(repo),
    })
}

fn upstream_name(repo: &Repository) -> Option<String> {
    let output = run_git(
        repo.workdir(),
        &["rev-parse", "--abbrev-ref", "@{upstream}"],
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() || name == "@{upstream}" {
        None
    } else {
        Some(name)
    }
}

pub fn status_snapshot(repo: &Repository) -> AppResult<StatusSnapshot> {
    status_from_git(workdir(repo)?)
}

pub(super) fn status_from_git(root: &Path) -> AppResult<StatusSnapshot> {
    let output = run_git(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=no",
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::msg(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    parse_porcelain(&output.stdout)
}

pub(super) fn parse_porcelain(bytes: &[u8]) -> AppResult<StatusSnapshot> {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut rest = bytes;

    while !rest.is_empty() {
        if rest[0] == 0 {
            rest = &rest[1..];
            continue;
        }
        if rest.len() < 3 {
            break;
        }
        let x = rest[0] as char;
        let y = rest[1] as char;
        rest = &rest[3..];
        let (first, next) = split_z(rest);
        let first = String::from_utf8_lossy(first).replace('\\', "/");
        // With -z a rename is written as `XY new\0old\0`.
        let (path, old_path, next) = if matches!(x, 'R' | 'C') {
            let (second, next) = split_z(next);
            (
                first,
                Some(String::from_utf8_lossy(second).replace('\\', "/")),
                next,
            )
        } else {
            (first, None, next)
        };
        rest = next;

        if x == '?' || y == '?' {
            unstaged.push(FileStatus {
                path,
                old_path: None,
                kind: "untracked".to_string(),
                staged: false,
            });
            continue;
        }

        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            unstaged.push(FileStatus {
                path,
                old_path,
                kind: "conflicted".to_string(),
                staged: false,
            });
            continue;
        }

        if x != ' ' {
            staged.push(FileStatus {
                path: path.clone(),
                old_path: old_path.clone(),
                kind: kind_from_xy(x).to_string(),
                staged: true,
            });
        }
        if y != ' ' {
            unstaged.push(FileStatus {
                path,
                old_path,
                kind: kind_from_xy(y).to_string(),
                staged: false,
            });
        }
    }

    Ok(StatusSnapshot { staged, unstaged })
}

pub(super) fn split_z(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().position(|&byte| byte == 0) {
        Some(index) => (&bytes[..index], &bytes[index + 1..]),
        None => (bytes, &[]),
    }
}

pub(super) fn kind_from_xy(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    }
}

pub(super) fn cached_ahead_behind(
    repo: &Repository,
    local: &str,
    upstream: &str,
) -> Option<(usize, usize)> {
    struct Entry {
        local: String,
        upstream: String,
        ahead: usize,
        behind: usize,
    }
    static CACHE: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard
            .iter()
            .find(|entry| entry.local == local && entry.upstream == upstream)
        {
            return Some((hit.ahead, hit.behind));
        }
    }
    let output = run_git(
        repo.workdir(),
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let ahead = parts.next()?.parse().ok()?;
    let behind = parts.next()?.parse().ok()?;
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|entry| entry.local != local || entry.upstream != upstream);
        guard.push(Entry {
            local: local.to_string(),
            upstream: upstream.to_string(),
            ahead,
            behind,
        });
        if guard.len() > 8 {
            let extra = guard.len() - 8;
            guard.drain(0..extra);
        }
    }
    Some((ahead, behind))
}

pub(super) fn snapshot_mutex(root: &Path) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = gates.lock().unwrap_or_else(|err| err.into_inner());
    map.entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub fn snapshot(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    let root = workdir(repo)?.to_path_buf();
    let gate = snapshot_mutex(&root);
    let _guard = gate.lock().unwrap_or_else(|err| err.into_inner());
    let status_root = root.clone();
    let status_task = thread::spawn(move || status_from_git(&status_root));
    let built: AppResult<_> = (|| {
        let info = repo_info(repo)?;
        let branches = branch_list(repo, false, info.current_branch.clone(), info.is_detached)?;
        let remotes = list_remotes(repo)?;
        let stashes = list_stashes(repo)?;
        Ok((info, branches, remotes, stashes, head_commit(repo)))
    })();
    let status_result = match status_task.join() {
        Ok(result) => result,
        Err(_) => Err(AppError::msg("Could not read status")),
    };
    let (info, branches, remotes, stashes, head) = built?;
    let status = status_result?;
    Ok(WorkspaceSnapshot {
        repo: info,
        status,
        branches,
        remotes,
        stashes,
        head_commit: head,
    })
}

pub(super) fn head_commit(repo: &Repository) -> Option<CommitSummary> {
    let oid = head_oid(repo)?;
    summarize_oid(repo, &oid).ok()
}
