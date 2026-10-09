use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub path: String,
    pub binary: bool,
    pub text: String,
}

pub fn conflict_view(repo: &Repository, path: &str) -> AppResult<ConflictView> {
    let path = to_git_path(path);
    if path.is_empty() {
        return Err(AppError::msg("A file path is required"));
    }
    if let Ok(abs) = ensure_inside_workdir(repo, &path) {
        if abs.is_file() {
            let bytes = fs::read(&abs)?;
            if bytes.contains(&0) {
                return Ok(ConflictView {
                    path,
                    binary: true,
                    text: String::new(),
                });
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if text.contains("<<<<<<<") {
                return Ok(ConflictView {
                    path,
                    binary: false,
                    text,
                });
            }
        }
    }
    let ours = stage_text(repo, &path, 2);
    let theirs = stage_text(repo, &path, 3);
    if ours.is_none() && theirs.is_none() {
        return Ok(ConflictView {
            path,
            binary: true,
            text: String::new(),
        });
    }
    let ours = with_trailing_newline(ours.unwrap_or_default());
    let theirs = with_trailing_newline(theirs.unwrap_or_default());
    Ok(ConflictView {
        path,
        binary: false,
        text: format!("<<<<<<< Current\n{ours}=======\n{theirs}>>>>>>> Incoming\n"),
    })
}

/// A stash apply can leave conflicts without any merge or rebase in progress,
/// so the index entry decides whether a path can be resolved.
fn ensure_conflicted(repo: &Repository, path: &str) -> AppResult<()> {
    let mut index = repo.index()?;
    index.read(false)?;
    if (1..=3).any(|stage| index.get_path(Path::new(path), stage).is_some()) {
        return Ok(());
    }
    Err(AppError::msg("This file has no conflict to resolve"))
}

pub fn save_conflict(repo: &mut Repository, path: &str, text: &str) -> AppResult<WorkspaceSnapshot> {
    let path = to_git_path(path);
    if path.is_empty() {
        return Err(AppError::msg("A file path is required"));
    }
    ensure_conflicted(repo, &path)?;
    if text.contains("<<<<<<<") || text.contains(">>>>>>>") {
        return Err(AppError::msg("Conflict markers are still in the file"));
    }
    let abs = ensure_inside_workdir(repo, &path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&abs, text)?;
    let root = workdir(repo)?.to_path_buf();
    run_git_stdout(&root, &["add", "--", &path])?;
    snapshot(repo)
}

pub(super) fn with_trailing_newline(text: String) -> String {
    if text.is_empty() || text.ends_with('\n') {
        text
    } else {
        format!("{text}\n")
    }
}

pub(super) fn stage_text(repo: &Repository, path: &str, stage: i32) -> Option<String> {
    let index = repo.index().ok()?;
    let entry = index.get_path(Path::new(path), stage)?;
    let blob = repo.find_blob(entry.id).ok()?;
    let bytes = blob.content();
    if bytes.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

pub fn resolve_conflict(repo: &mut Repository, path: &str, side: &str) -> AppResult<WorkspaceSnapshot> {
    let path = to_git_path(path);
    if path.is_empty() {
        return Err(AppError::msg("A file path is required"));
    }
    ensure_conflicted(repo, &path)?;
    let root = workdir(repo)?.to_path_buf();
    match side.trim() {
        "ours" => run_git_stdout(&root, &["checkout", "--ours", "--", &path])?,
        "theirs" => run_git_stdout(&root, &["checkout", "--theirs", "--", &path])?,
        "both" => resolve_both_sides(&root, &path)?,
        _ => {
            return Err(AppError::msg(
                "Choose a side: ours, theirs, or both",
            ))
        }
    };
    run_git_stdout(&root, &["add", "--", &path])?;
    snapshot(repo)
}

pub(super) fn resolve_both_sides(root: &Path, path: &str) -> AppResult<Vec<u8>> {
    let file = root.join(path);
    let text = fs::read_to_string(&file).map_err(|_| {
        AppError::msg("This conflict has no text markers. Choose current or incoming.")
    })?;
    let resolved = take_both_sides(&text).ok_or_else(|| {
        AppError::msg("This conflict has no text markers. Choose current or incoming.")
    })?;
    fs::write(&file, resolved)?;
    Ok(Vec::new())
}

pub(super) fn take_both_sides(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    let mut found = false;
    while let Some(start) = rest.find("<<<<<<<") {
        found = true;
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let line_end = after.find('\n').unwrap_or(after.len());
        let body = &after[line_end + usize::from(line_end < after.len())..];
        let mid = body.find("\n=======")?;
        let mut ours = &body[..mid];
        if let Some(base_at) = ours.find("\n|||||||") {
            ours = &ours[..base_at];
        }
        let after_mid = &body[mid + 1..];
        let marker_end = after_mid.find('\n').unwrap_or(after_mid.len());
        let theirs_and_rest = &after_mid[marker_end + usize::from(marker_end < after_mid.len())..];
        let end = theirs_and_rest.find(">>>>>>>")?;
        let theirs = &theirs_and_rest[..end];
        out.push_str(ours);
        if !ours.ends_with('\n') && !theirs.is_empty() {
            out.push('\n');
        }
        out.push_str(theirs);
        let after_end = &theirs_and_rest[end..];
        let end_line = after_end.find('\n').map(|index| index + 1).unwrap_or(after_end.len());
        rest = &after_end[end_line..];
    }
    if !found {
        return None;
    }
    out.push_str(rest);
    Some(out)
}
