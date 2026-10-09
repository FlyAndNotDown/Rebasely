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
    let reflog = match repo.reflog("HEAD") {
        Ok(reflog) => reflog,
        Err(err) if err.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut entries = Vec::new();
    for (index, entry) in reflog.iter().take(limit).enumerate() {
        let id = entry.id_new();
        let summary = repo
            .find_commit(id)
            .ok()
            .and_then(|commit| commit.summary().map(str::to_string))
            .unwrap_or_default();
        entries.push(ReflogEntry {
            selector: format!("HEAD@{{{index}}}"),
            id: id.to_string(),
            short_id: short_id(&id.to_string()),
            message: entry.message().unwrap_or("").trim().to_string(),
            timestamp: entry.committer().when().seconds(),
            summary,
        });
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
        let head = repo
            .head()
            .map_err(|_| AppError::msg("There is no commit to undo"))?;
        if !head.is_branch() {
            return Err(AppError::msg("Undo needs a checked-out branch"));
        }
        let commit = head.peel_to_commit()?;
        let refname = head
            .name()
            .ok_or_else(|| AppError::msg("Invalid branch reference"))?
            .to_string();
        let parent = commit.parent_id(0).ok().map(|id| id.to_string());
        (commit.message().unwrap_or("").trim().to_string(), refname, parent)
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
