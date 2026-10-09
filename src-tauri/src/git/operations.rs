use super::*;

pub fn revert_commit(repo: &mut Repository, spec: &str) -> AppResult<WorkspaceSnapshot> {
    let (oid, is_merge) = {
        let commit = peel_commit(repo, spec)?;
        (commit.id().to_string(), commit.parent_count() > 1)
    };
    ensure_clean_for_replay(repo)?;
    let root = workdir(repo)?;
    let result = if is_merge {
        run_git_stdout(root, &["revert", "--no-edit", "-m", "1", &oid])
    } else {
        run_git_stdout(root, &["revert", "--no-edit", &oid])
    };
    if let Err(err) = result {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn reset_to_commit(
    repo: &mut Repository,
    spec: &str,
    mode: &str,
) -> AppResult<WorkspaceSnapshot> {
    let flag = reset_flag(mode)?;
    let oid = peel_commit(repo, spec)?.id();
    ensure_reset_target(repo, oid)?;
    let oid = oid.to_string();
    run_git_stdout(workdir(repo)?, &["reset", flag, &oid])?;
    snapshot(repo)
}

pub(super) fn reset_flag(mode: &str) -> AppResult<&'static str> {
    match mode.trim() {
        "soft" => Ok("--soft"),
        "mixed" => Ok("--mixed"),
        "hard" => Ok("--hard"),
        "merge" => Ok("--merge"),
        "keep" => Ok("--keep"),
        _ => Err(AppError::msg(
            "Choose a reset mode: soft, mixed, hard, merge, or keep",
        )),
    }
}

pub(super) fn ensure_reset_target(repo: &Repository, _target: Oid) -> AppResult<()> {
    let head = repo
        .head()
        .map_err(|_| AppError::msg("Reset needs a checked-out branch"))?;
    if !head.is_branch() {
        return Err(AppError::msg(
            "Reset is only available on the current local branch",
        ));
    }
    Ok(())
}

pub fn cherry_pick_commit(repo: &mut Repository, spec: &str) -> AppResult<WorkspaceSnapshot> {
    let (oid, is_merge) = {
        let commit = peel_commit(repo, spec)?;
        (commit.id().to_string(), commit.parent_count() > 1)
    };
    ensure_clean_for_replay(repo)?;
    let root = workdir(repo)?;
    let result = if is_merge {
        run_git_stdout(root, &["cherry-pick", "-m", "1", &oid])
    } else {
        run_git_stdout(root, &["cherry-pick", &oid])
    };
    if let Err(err) = result {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn rebase_plan(repo: &Repository, onto: &str) -> AppResult<Vec<RebaseCommit>> {
    ensure_rebase_ready(repo)?;
    let onto_id = peel_commit(repo, onto)?.id().to_string();
    commits_to_replay(repo, &onto_id)
}

pub fn rebase_onto(repo: &mut Repository, onto: &str) -> AppResult<WorkspaceSnapshot> {
    ensure_rebase_ready(repo)?;
    let onto_id = peel_commit(repo, onto)?.id().to_string();
    let commits = commits_to_replay(repo, &onto_id)?;
    if commits.is_empty() {
        return Err(AppError::msg("Already up to date"));
    }
    let root = workdir(repo)?.to_path_buf();
    if let Err(err) = run_git_stdout(&root, &["rebase", &onto_id]) {
        return Err(rebase_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn rebase_interactive(
    repo: &mut Repository,
    onto: &str,
    steps: &[RebaseStep],
) -> AppResult<WorkspaceSnapshot> {
    ensure_rebase_ready(repo)?;
    let onto_id = peel_commit(repo, onto)?.id().to_string();
    let commits = commits_to_replay(repo, &onto_id)?;
    if commits.is_empty() {
        return Err(AppError::msg("Nothing to rebase"));
    }
    let todo = rebase_todo(&commits, steps)?;
    let root = workdir(repo)?.to_path_buf();
    let scratch = rebase_scratch_dir()?;
    let result = run_interactive_rebase(&root, &onto_id, &scratch, &todo);
    let _ = fs::remove_dir_all(&scratch);
    if let Err(err) = result {
        return Err(rebase_stop_error(repo, err));
    }
    snapshot(repo)
}

pub fn rebase_continue(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    rebase_control(repo, "--continue")
}

pub fn rebase_skip(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    rebase_control(repo, "--skip")
}

pub fn rebase_abort(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    rebase_control(repo, "--abort")
}

pub fn merge_ref(repo: &mut Repository, spec: &str) -> AppResult<WorkspaceSnapshot> {
    ensure_merge_ready(repo)?;
    let target = peel_commit(repo, spec)?.id().to_string();
    let root = workdir(repo)?.to_path_buf();
    if let Err(err) = run_git_stdout(&root, &["merge", "--no-edit", &target]) {
        return Err(operation_stop_error(repo, err));
    }
    snapshot(repo)
}

/// Finishes the current step. An edited `message` replaces the one git prepared.
pub fn operation_continue(repo: &mut Repository, message: Option<&str>) -> AppResult<WorkspaceSnapshot> {
    let kind = git_operation(repo)
        .ok_or_else(|| AppError::msg("No merge, rebase, cherry-pick, or revert is in progress"))?
        .kind;
    let message = message.map(str::trim).filter(|value| !value.is_empty());
    if let Some(message) = message {
        if kind == "rebase" {
            // `rebase --continue` commits with rebase-merge/message.
            let body = format!("{message}\n");
            let rebase_dir = repo.path().join("rebase-merge");
            if rebase_dir.is_dir() {
                fs::write(rebase_dir.join("message"), &body)?;
            }
            fs::write(repo.path().join("MERGE_MSG"), &body)?;
        } else {
            // A plain `git commit` finishes a single merge, cherry-pick, or
            // revert, keeping the extra parent or original author.
            commit(repo, message, false)?;
            return snapshot(repo);
        }
    }
    let flag = match kind.as_str() {
        "rebase" => "rebase",
        "merge" => "merge",
        "cherry-pick" => "cherry-pick",
        "revert" => "revert",
        _ => return Err(AppError::msg("No operation is in progress")),
    };
    run_operation(repo, &[flag, "--continue"])
}

pub fn operation_abort(repo: &mut Repository) -> AppResult<WorkspaceSnapshot> {
    let kind = git_operation(repo)
        .ok_or_else(|| AppError::msg("No merge, rebase, cherry-pick, or revert is in progress"))?
        .kind;
    let flag = match kind.as_str() {
        "rebase" => "rebase",
        "merge" => "merge",
        "cherry-pick" => "cherry-pick",
        "revert" => "revert",
        _ => return Err(AppError::msg("No operation is in progress")),
    };
    run_operation(repo, &[flag, "--abort"])
}

pub(super) fn run_operation(repo: &mut Repository, args: &[&str]) -> AppResult<WorkspaceSnapshot> {
    let root = workdir(repo)?.to_path_buf();
    let scratch = rebase_scratch_dir()?;
    let editor = noop_editor(&scratch)?;
    let result = run_git_env(&root, args, &[("GIT_EDITOR", editor.as_str())]);
    let _ = fs::remove_dir_all(&scratch);
    match result {
        Ok(output) if output.status.success() => snapshot(repo),
        Ok(output) => Err(operation_stop_error(repo, git_output_error(output))),
        Err(err) => Err(operation_stop_error(repo, err)),
    }
}

pub(super) fn ensure_merge_ready(repo: &Repository) -> AppResult<()> {
    if git_operation(repo).is_some() {
        return Err(AppError::msg("Finish or abort the current operation first"));
    }
    let head = repo
        .head()
        .map_err(|_| AppError::msg("Merge needs a checked-out branch"))?;
    if !head.is_branch() {
        return Err(AppError::msg("Merge needs a checked-out branch"));
    }
    ensure_clean_for_replay(repo)
}

pub(super) fn rebase_control(repo: &mut Repository, flag: &str) -> AppResult<WorkspaceSnapshot> {
    if rebase_progress(repo).is_none() {
        return Err(AppError::msg("No rebase is in progress"));
    }
    let root = workdir(repo)?.to_path_buf();
    let scratch = rebase_scratch_dir()?;
    let editor = noop_editor(&scratch)?;
    let result = run_git_env(
        &root,
        &["rebase", flag],
        &[("GIT_EDITOR", editor.as_str())],
    );
    let _ = fs::remove_dir_all(&scratch);
    match result {
        Ok(output) if output.status.success() => snapshot(repo),
        Ok(output) => Err(rebase_stop_error(repo, git_output_error(output))),
        Err(err) => Err(rebase_stop_error(repo, err)),
    }
}

pub(super) fn commits_to_replay(repo: &Repository, onto: &str) -> AppResult<Vec<RebaseCommit>> {
    let spec = format!("{onto}..HEAD");
    let bytes = run_git_stdout(
        workdir(repo)?,
        &["rev-list", "--reverse", "--no-merges", &spec],
    )?;
    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&bytes).lines() {
        let id = line.trim();
        if id.is_empty() {
            continue;
        }
        let commit = peel_commit(repo, id)?;
        let summary = commit.summary().unwrap_or("").trim().to_string();
        commits.push(RebaseCommit {
            id: commit.id().to_string(),
            short_id: short_id(&commit.id().to_string()),
            summary,
        });
    }
    Ok(commits)
}

pub(super) fn rebase_todo(commits: &[RebaseCommit], steps: &[RebaseStep]) -> AppResult<RebaseTodo> {
    if steps.len() != commits.len() {
        return Err(AppError::msg(
            "The rebase plan does not match the commits on this branch",
        ));
    }
    let mut seen = HashSet::new();
    let mut lines = Vec::new();
    let mut messages = Vec::new();
    for step in steps {
        let action = step.action.trim().to_ascii_lowercase();
        if !matches!(action.as_str(), "pick" | "reword" | "squash" | "fixup" | "drop") {
            return Err(AppError::msg(format!("Unknown rebase action: {action}")));
        }
        if matches!(action.as_str(), "squash" | "fixup")
            && !lines.iter().any(|line: &String| !line.starts_with("drop "))
        {
            return Err(AppError::msg(
                "Squash and fixup need a picked or reworded commit before them",
            ));
        }
        let id = step.id.trim();
        if !seen.insert(id.to_string()) {
            return Err(AppError::msg("Each commit can appear only once"));
        }
        let commit = commits
            .iter()
            .find(|commit| commit.id == id)
            .ok_or_else(|| AppError::msg("The rebase plan includes a commit outside this range"))?;
        let subject = commit.summary.replace(['\r', '\n'], " ");
        lines.push(format!("{action} {id} {subject}"));
        if matches!(action.as_str(), "reword" | "squash") {
            let message = step.message.trim();
            if message.is_empty() {
                return Err(AppError::msg("Reword and squash need a commit message"));
            }
            messages.push(message.to_string());
        }
    }
    if seen.len() != commits.len() {
        return Err(AppError::msg(
            "The rebase plan does not match the commits on this branch",
        ));
    }
    if lines.iter().all(|line| line.starts_with("drop ")) {
        return Err(AppError::msg("Dropping every commit leaves nothing to rebase"));
    }
    Ok(RebaseTodo { lines, messages })
}

pub(super) struct RebaseTodo {
    lines: Vec<String>,
    messages: Vec<String>,
}

pub(super) fn run_interactive_rebase(
    root: &Path,
    onto: &str,
    scratch: &Path,
    todo: &RebaseTodo,
) -> AppResult<()> {
    let sequence = sequence_editor(scratch, &todo.lines)?;
    let message = message_editor(scratch, &todo.messages)?;
    let output = run_git_env(
        root,
        &["rebase", "-i", onto],
        &[
            ("GIT_SEQUENCE_EDITOR", sequence.as_str()),
            ("GIT_EDITOR", message.as_str()),
        ],
    )?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_output_error(output))
}

pub(super) fn rebase_scratch_dir() -> AppResult<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "rebasely-rebase-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub(super) fn sequence_editor(scratch: &Path, lines: &[String]) -> AppResult<String> {
    let todo = scratch.join("todo");
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(&todo, body)?;
    write_copy_editor(scratch, "sequence-editor", &todo)
}

pub(super) fn message_editor(scratch: &Path, messages: &[String]) -> AppResult<String> {
    for (index, message) in messages.iter().enumerate() {
        let mut body = message.trim().to_string();
        body.push('\n');
        fs::write(scratch.join(format!("msg-{index}")), body)?;
    }
    fs::write(scratch.join("counter"), "0")?;
    if cfg!(windows) {
        let script = scratch.join("message-editor.ps1");
        let dir = scratch.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!(
                "$dest = $args[$args.Length - 1]\n$dir = '{dir}'\n$n = [int](Get-Content -LiteralPath (Join-Path $dir 'counter'))\n$src = Join-Path $dir (\"msg-$n\")\nif (Test-Path -LiteralPath $src) {{ Copy-Item -LiteralPath $src -Destination $dest -Force }}\nSet-Content -LiteralPath (Join-Path $dir 'counter') -Value ($n + 1) -NoNewline\nexit 0\n"
            ),
        )?;
        Ok(format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ))
    } else {
        let script = scratch.join("message-editor");
        fs::write(
            &script,
            "#!/bin/sh\ndir=$(dirname \"$0\")\nn=$(cat \"$dir/counter\")\nif [ -f \"$dir/msg-$n\" ]; then cp \"$dir/msg-$n\" \"$1\"; fi\necho $((n + 1)) > \"$dir/counter\"\nexit 0\n",
        )?;
        make_executable(&script)?;
        Ok(script.to_string_lossy().into_owned())
    }
}

pub(super) fn noop_editor(scratch: &Path) -> AppResult<String> {
    if cfg!(windows) {
        let script = scratch.join("noop-editor.ps1");
        fs::write(&script, "exit 0\n")?;
        Ok(format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ))
    } else {
        let script = scratch.join("noop-editor");
        fs::write(&script, "#!/bin/sh\nexit 0\n")?;
        make_executable(&script)?;
        Ok(script.to_string_lossy().into_owned())
    }
}

pub(super) fn write_copy_editor(scratch: &Path, name: &str, source: &Path) -> AppResult<String> {
    if cfg!(windows) {
        let script = scratch.join(format!("{name}.ps1"));
        let from = source.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!(
                "$dest = $args[$args.Length - 1]\nCopy-Item -LiteralPath '{from}' -Destination $dest -Force\nexit 0\n"
            ),
        )?;
        Ok(format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ))
    } else {
        let script = scratch.join(name);
        let from = source.to_string_lossy().replace('\'', "'\\''");
        fs::write(
            &script,
            format!("#!/bin/sh\ncp '{from}' \"$1\"\nexit 0\n"),
        )?;
        make_executable(&script)?;
        Ok(script.to_string_lossy().into_owned())
    }
}

pub(super) fn make_executable(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }
    let _ = path;
    Ok(())
}

pub(super) fn rebase_progress(repo: &Repository) -> Option<RebaseProgress> {
    let git_dir = repo.path();
    let dir = ["rebase-merge", "rebase-apply"]
        .into_iter()
        .map(|name| git_dir.join(name))
        .find(|path| path.is_dir())?;
    let read = |name: &str| {
        fs::read_to_string(dir.join(name))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(RebaseProgress {
        onto: read("onto"),
        head_name: read("head-name").map(|name| {
            name.trim_start_matches("refs/heads/")
                .trim_start_matches("refs/remotes/")
                .to_string()
        }),
        step: read("msgnum").and_then(|value| value.parse().ok()),
        total: read("end").and_then(|value| value.parse().ok()),
    })
}

pub(super) fn git_operation(repo: &Repository) -> Option<GitOperation> {
    let git_dir = repo.path();
    if let Some(rebase) = rebase_progress(repo) {
        let message = read_commit_message(&git_dir.join("rebase-merge").join("message"))
            .or_else(|| read_commit_message(&git_dir.join("MERGE_MSG")));
        return Some(GitOperation {
            kind: "rebase".to_string(),
            head_name: rebase.head_name,
            onto: rebase.onto,
            step: rebase.step,
            total: rebase.total,
            message,
        });
    }
    let marker = [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .into_iter()
    .find(|(name, _)| git_dir.join(name).is_file())?;
    let onto = fs::read_to_string(git_dir.join(marker.0))
        .ok()
        .map(|value| value.trim().chars().take(7).collect())
        .filter(|value: &String| !value.is_empty());
    Some(GitOperation {
        kind: marker.1.to_string(),
        head_name: None,
        onto,
        step: None,
        total: None,
        message: read_commit_message(&git_dir.join("MERGE_MSG")),
    })
}

/// Reads a prepared commit message without the `#` comment lines git adds,
/// such as the list of conflicted files.
pub(super) fn read_commit_message(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let kept: Vec<&str> = text
        .lines()
        .take_while(|line| !line.starts_with("# ------------------------ >8"))
        .filter(|line| !line.starts_with('#'))
        .collect();
    let message = kept.join("\n").trim().to_string();
    (!message.is_empty()).then_some(message)
}

pub(super) fn ensure_rebase_ready(repo: &Repository) -> AppResult<()> {
    if git_operation(repo).is_some() {
        return Err(AppError::msg("Finish or abort the current operation first"));
    }
    let head = repo
        .head()
        .map_err(|_| AppError::msg("Rebase needs a checked-out branch"))?;
    if !head.is_branch() {
        return Err(AppError::msg("Rebase needs a checked-out branch"));
    }
    ensure_clean_for_replay(repo)
}

pub(super) fn rebase_stop_error(repo: &Repository, err: AppError) -> AppError {
    operation_stop_error(repo, err)
}

pub(super) fn operation_stop_error(repo: &Repository, err: AppError) -> AppError {
    let Some(operation) = git_operation(repo) else {
        return err;
    };
    let name = match operation.kind.as_str() {
        "merge" => "Merge",
        "cherry-pick" => "Cherry-pick",
        "revert" => "Revert",
        _ => "Rebase",
    };
    AppError::msg(format!(
        "{name} stopped with conflicts. Resolve them on Changes, then continue or abort.\n{err}"
    ))
}

pub fn write_commit_patch(repo: &Repository, spec: &str, dest: &str) -> AppResult<()> {
    let oid = peel_commit(repo, spec)?.id().to_string();
    let dest = dest.trim();
    if dest.is_empty() {
        return Err(AppError::msg("A patch path is required"));
    }
    let bytes = run_git_stdout(workdir(repo)?, &["format-patch", "-1", "--stdout", &oid])?;
    if bytes.is_empty() {
        return Err(AppError::msg("Git produced an empty patch"));
    }
    fs::write(dest, bytes)?;
    Ok(())
}

pub fn apply_patch(repo: &mut Repository, patch_path: &str) -> AppResult<WorkspaceSnapshot> {
    let path = PathBuf::from(patch_path.trim());
    if !path.is_file() {
        return Err(AppError::msg("Patch file was not found"));
    }
    let bytes = fs::read(&path)?;
    if bytes.is_empty() {
        return Err(AppError::msg("Patch file is empty"));
    }
    let root = workdir(repo)?;
    let path = path.to_string_lossy().into_owned();
    if looks_like_mbox(&bytes) {
        ensure_clean_for_replay(repo)?;
        run_git_stdout(root, &["am", "--3way", &path])?;
    } else {
        run_git_stdout(root, &["apply", "--3way", "--", &path])?;
    }
    snapshot(repo)
}

pub(super) fn looks_like_mbox(bytes: &[u8]) -> bool {
    let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]);
    let start = preview.trim_start_matches('\u{feff}');
    start.starts_with("From ") || preview.contains("\nFrom ")
}

pub(super) fn ensure_clean_for_replay(repo: &Repository) -> AppResult<()> {
    let status = status_snapshot(repo)?;
    if !status.staged.is_empty()
        || status
            .unstaged
            .iter()
            .any(|file| file.kind != "untracked")
    {
        return Err(AppError::msg("Commit or stash your changes first"));
    }
    Ok(())
}
