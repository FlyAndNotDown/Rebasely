use super::*;

pub fn repo_info(repo: &Repository) -> AppResult<RepoInfo> {
    let path = canonical_workdir(repo)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository")
        .to_string();

    let current_branch;
    let mut head_id = None;
    let mut is_detached = false;
    let mut ahead = None;
    let mut behind = None;
    let mut upstream = None;

    match repo.head() {
        Ok(head) => {
            is_detached = !head.is_branch();
            current_branch = head.shorthand().map(|name| name.to_string());
            if let Some(oid) = head.target() {
                head_id = Some(oid.to_string());
            }
            if head.is_branch() {
                if let Ok(branch) = repo.find_branch(
                    head.shorthand().unwrap_or(""),
                    BranchType::Local,
                ) {
                    if let Ok(up) = branch.upstream() {
                        upstream = up.name()?.map(|name| name.to_string());
                        if let (Some(local_oid), Some(up_oid)) =
                            (branch.get().target(), up.get().target())
                        {
                            if let Some((a, b)) = cached_ahead_behind(repo, local_oid, up_oid) {
                                ahead = Some(a);
                                behind = Some(b);
                            }
                        }
                    }
                }
            }
        }
        Err(err) if err.code() == ErrorCode::UnbornBranch => {
            current_branch = repo.find_reference("HEAD").ok().and_then(|head| {
                head.symbolic_target().map(|target| {
                    target
                        .trim_start_matches("refs/heads/")
                        .to_string()
                })
            });
        }
        Err(err) => return Err(err.into()),
    }

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

pub(super) fn kind_from_status(status: Status, staged: bool) -> &'static str {
    if status.is_conflicted() {
        return "conflicted";
    }
    if staged {
        if status.is_index_new() {
            return "added";
        }
        if status.is_index_deleted() {
            return "deleted";
        }
        if status.is_index_renamed() {
            return "renamed";
        }
        if status.is_index_typechange() {
            return "typechange";
        }
        return "modified";
    }
    if status.is_wt_new() {
        return "untracked";
    }
    if status.is_wt_deleted() {
        return "deleted";
    }
    if status.is_wt_renamed() {
        return "renamed";
    }
    if status.is_wt_typechange() {
        return "typechange";
    }
    "modified"
}

pub fn status_snapshot(repo: &Repository) -> AppResult<StatusSnapshot> {
    let root = workdir(repo)?;
    if let Ok(snapshot) = status_from_git(root) {
        return Ok(snapshot);
    }
    status_from_libgit2(repo)
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
        let (path, old_path, next) = if matches!(x, 'R' | 'C') {
            let (second, next) = split_z(next);
            (
                String::from_utf8_lossy(second).replace('\\', "/"),
                Some(first),
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

pub(super) fn status_from_libgit2(repo: &Repository) -> AppResult<StatusSnapshot> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(false)
        .include_ignored(false)
        .exclude_submodules(true)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false);

    let statuses = repo.statuses(Some(&mut opts))?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_ignored() {
            continue;
        }

        let path = entry.path().unwrap_or_default().replace('\\', "/");
        let old_path = entry
            .head_to_index()
            .and_then(|delta| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"));

        let index_flags = Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE;

        if status.intersects(index_flags) || status.is_conflicted() {
            staged.push(FileStatus {
                path: path.clone(),
                old_path: old_path.clone(),
                kind: kind_from_status(status, true).to_string(),
                staged: true,
            });
        }

        let wt_flags = Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE
            | Status::CONFLICTED;

        if status.intersects(wt_flags) {
            unstaged.push(FileStatus {
                path,
                old_path,
                kind: kind_from_status(status, false).to_string(),
                staged: false,
            });
        }
    }

    Ok(StatusSnapshot { staged, unstaged })
}

pub(super) fn cached_ahead_behind(repo: &Repository, local: Oid, upstream: Oid) -> Option<(usize, usize)> {
    struct Entry {
        local: Oid,
        upstream: Oid,
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
    let (ahead, behind) = repo.graph_ahead_behind(local, upstream).ok()?;
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|entry| entry.local != local || entry.upstream != upstream);
        guard.push(Entry {
            local,
            upstream,
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
    let status = match status_result {
        Ok(status) => status,
        Err(_) => status_from_libgit2(repo)?,
    };
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
    let oid = repo.head().ok()?.target()?;
    summarize_oid(repo, oid).ok()
}
