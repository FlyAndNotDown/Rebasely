use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// `HEAD@{n}`
    pub selector: String,
    pub id: String,
    pub short_id: String,
    /// What moved HEAD, e.g. `commit: Fix the build` or `checkout: moving from a to b`.
    pub message: String,
    pub timestamp: i64,
    /// The subject of the commit HEAD moved to, when it still exists.
    pub summary: String,
}

/// The newest `limit` movements of HEAD.
pub fn head_reflog(repo: &Repository, limit: usize) -> AppResult<Vec<ReflogEntry>> {
    let count = limit.max(1).to_string();
    let output = run_git(
        workdir(repo)?,
        &[
            "reflog",
            "show",
            "-n",
            &count,
            "--format=%H%x1f%gs%x1f%gd%x1f%ct",
            "HEAD",
        ],
    )?;
    if !output.status.success() {
        let message = git_output_error(output).to_string();
        if message.contains("does not have a reflog")
            || message.contains("no reflog")
            || message.contains("unknown revision")
            || message.contains("ambiguous argument")
        {
            return Ok(Vec::new());
        }
        return Err(AppError::msg(message));
    }
    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split('\u{1f}');
        let Some(id) = fields.next().map(str::trim).filter(|id| !id.is_empty()) else {
            continue;
        };
        let message = fields.next().unwrap_or("").trim().to_string();
        let selector = fields.next().unwrap_or("").trim().to_string();
        let timestamp = fields.next().unwrap_or("").trim().parse().unwrap_or(0);
        entries.push(ReflogEntry {
            selector: if selector.is_empty() {
                format!("HEAD@{{{}}}", entries.len())
            } else {
                selector
            },
            id: id.to_string(),
            short_id: short_id(id),
            message,
            timestamp,
            summary: String::new(),
        });
    }
    if !entries.is_empty() {
        let mut args = vec![
            "-c",
            "log.showSignature=false",
            "log",
            "--no-walk",
            "--format=%H%x1f%s",
        ];
        let ids: Vec<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        args.extend(ids.iter().map(String::as_str));
        if let Ok(stdout) = run_git_stdout(workdir(repo)?, &args) {
            let mut subjects = HashMap::new();
            for line in String::from_utf8_lossy(&stdout).lines() {
                if let Some((id, summary)) = line.split_once('\u{1f}') {
                    subjects.insert(id.to_string(), summary.trim().to_string());
                }
            }
            for entry in &mut entries {
                if let Some(summary) = subjects.get(&entry.id) {
                    entry.summary = summary.clone();
                }
            }
        }
    }
    Ok(entries)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoneCommit {
    pub snapshot: WorkspaceSnapshot,
    /// The undone commit's full message, to put back in the commit box.
    pub message: String,
}

/// Moves the branch back one commit and keeps that commit's changes staged.
pub fn undo_last_commit(repo: &mut Repository) -> AppResult<UndoneCommit> {
    if git_operation(repo).is_some() {
        return Err(AppError::msg("Finish or abort the current operation first"));
    }
    let (message, refname, parent) = {
        let head = head_oid(repo).ok_or_else(|| AppError::msg("There is no commit to undo"))?;
        let branch = symbolic_branch(repo)
            .ok_or_else(|| AppError::msg("Undo needs a checked-out branch"))?;
        let commit = commit_info(repo, &head)?;
        (
            commit.message.trim().to_string(),
            format!("refs/heads/{branch}"),
            commit.parents.first().cloned(),
        )
    };
    let root = workdir_owned(repo)?;
    match parent {
        Some(parent) => {
            run_git_stdout(&root, &["reset", "--soft", &parent])?;
        }
        // The first commit: drop the branch and leave its files in the index.
        None => {
            run_git_stdout(&root, &["update-ref", "-d", &refname])?;
        }
    }
    Ok(UndoneCommit {
        snapshot: snapshot(repo)?,
        message,
    })
}

/// Checks out a commit without a branch.
pub fn checkout_detached(repo: &Repository, spec: &str) -> AppResult<()> {
    let oid = peel_commit(repo, spec)?.id().to_string();
    run_git_stdout(workdir(repo)?, &["switch", "--quiet", "--detach", &oid])?;
    Ok(())
}
