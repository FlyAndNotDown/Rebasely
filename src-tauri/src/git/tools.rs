use super::*;

/// git's id for the empty tree, the "parent" of a root commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfig {
    pub diff_tool: String,
    pub merge_tool: String,
}

fn config_value(repo: Option<&Repository>, key: &str) -> Option<String> {
    let mut config = match repo {
        Some(repo) => repo.config().ok()?,
        None => git2::Config::open_default().ok()?,
    };
    config
        .snapshot()
        .ok()?
        .get_string(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The tools git would use, GUI variants first, as this repository sees them.
pub fn read_tool_config(repo: Option<&Repository>) -> ToolConfig {
    ToolConfig {
        diff_tool: config_value(repo, "diff.guitool")
            .or_else(|| config_value(repo, "diff.tool"))
            .unwrap_or_default(),
        merge_tool: config_value(repo, "merge.guitool")
            .or_else(|| config_value(repo, "merge.tool"))
            .unwrap_or_default(),
    }
}

/// Editors git has no built-in driver for, as `(name, difftool cmd, mergetool cmd)`.
const EDITOR_TOOLS: &[(&str, &str, &str)] = &[
    (
        "vscode",
        r#"code --wait --diff "$LOCAL" "$REMOTE""#,
        r#"code --wait --merge "$REMOTE" "$LOCAL" "$BASE" "$MERGED""#,
    ),
    (
        "cursor",
        r#"cursor --wait --diff "$LOCAL" "$REMOTE""#,
        r#"cursor --wait --merge "$REMOTE" "$LOCAL" "$BASE" "$MERGED""#,
    ),
];

/// Saves the tools to the global Git config. Choosing an editor that git does
/// not know adds the command it needs unless one is already set.
pub fn write_tool_config(config: &ToolConfig) -> AppResult<ToolConfig> {
    let path = global_gitconfig_path()?;
    if !path.exists() {
        fs::write(&path, "")?;
    }
    let mut cfg = git2::Config::open(&path)?;
    for (key, value) in [
        ("diff.tool", &config.diff_tool),
        ("merge.tool", &config.merge_tool),
    ] {
        let value = value.trim();
        if value.is_empty() {
            let _ = cfg.remove(key);
        } else {
            cfg.set_str(key, value)?;
        }
    }
    for (name, diff_cmd, merge_cmd) in EDITOR_TOOLS {
        if config.diff_tool.trim() == *name
            && cfg.get_string(&format!("difftool.{name}.cmd")).is_err()
        {
            cfg.set_str(&format!("difftool.{name}.cmd"), diff_cmd)?;
        }
        if config.merge_tool.trim() == *name
            && cfg.get_string(&format!("mergetool.{name}.cmd")).is_err()
        {
            cfg.set_str(&format!("mergetool.{name}.cmd"), merge_cmd)?;
            cfg.set_bool(&format!("mergetool.{name}.trustExitCode"), true)?;
        }
    }
    Ok(read_tool_config(None))
}

/// The `git difftool` arguments that show `source` the way the diff view does.
pub(super) fn difftool_args(repo: &Repository, source: &FileSource) -> AppResult<Vec<String>> {
    let mut args = vec!["difftool".to_string(), "--no-prompt".to_string()];
    let mut paths = Vec::new();
    match source {
        FileSource::Workdir { path, staged } => {
            if *staged {
                args.push("--cached".to_string());
            }
            paths.push(safe_repo_path(path)?);
        }
        FileSource::Commit {
            oid,
            path,
            old_path,
        } => {
            let commit = peel_commit(repo, oid)?;
            let parent = commit
                .parent_id(0)
                .map(|id| id.to_string())
                .unwrap_or_else(|_| EMPTY_TREE.to_string());
            args.extend(["-M".to_string(), parent, commit.id().to_string()]);
            paths.extend(
                old_path
                    .iter()
                    .map(|old| safe_repo_path(old))
                    .collect::<AppResult<Vec<_>>>()?,
            );
            paths.push(safe_repo_path(path)?);
        }
        FileSource::Compare {
            base,
            head,
            path,
            old_path,
        } => {
            args.extend([
                "-M".to_string(),
                peel_commit(repo, base)?.id().to_string(),
                peel_commit(repo, head)?.id().to_string(),
            ]);
            paths.extend(
                old_path
                    .iter()
                    .map(|old| safe_repo_path(old))
                    .collect::<AppResult<Vec<_>>>()?,
            );
            paths.push(safe_repo_path(path)?);
        }
        FileSource::Stash { oid, path } => {
            let stash = peel_commit(repo, oid)?;
            args.extend([stash.parent_id(0)?.to_string(), stash.id().to_string()]);
            paths.push(safe_repo_path(path)?);
        }
    }
    args.push("--".to_string());
    paths.dedup();
    args.extend(paths);
    Ok(args)
}

/// Starts the configured diff tool and returns at once; the tool stays open
/// for as long as the user likes, and `on_error` hears if git fails.
pub fn launch_difftool(
    repo: &Repository,
    source: &FileSource,
    on_error: impl FnOnce(String) + Send + 'static,
) -> AppResult<()> {
    // Without one, git falls back to a terminal tool such as vimdiff, which
    // would wait forever on a console nobody can see.
    if read_tool_config(Some(repo)).diff_tool.is_empty() {
        return Err(AppError::msg(
            "Choose a diff tool in Settings first, or set diff.tool in your Git config",
        ));
    }
    let mut args = difftool_args(repo, source)?;
    if config_value(Some(repo), "diff.guitool").is_some() {
        args.insert(1, "--gui".to_string());
    }
    let root = workdir_owned(repo)?;
    thread::spawn(move || {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_git(&root, &argv) {
            Ok(output) if !output.status.success() => {
                on_error(git_output_error(output).to_string())
            }
            Err(err) => on_error(err.to_string()),
            Ok(_) => {}
        }
    });
    Ok(())
}

/// Runs the configured merge tool on one conflicted file and waits for it.
pub fn run_mergetool(repo: &mut Repository, path: &str) -> AppResult<WorkspaceSnapshot> {
    let rel = safe_repo_path(path)?;
    if read_tool_config(Some(repo)).merge_tool.is_empty() {
        return Err(AppError::msg(
            "Choose a merge tool in Settings first, or set merge.tool in your Git config",
        ));
    }
    ensure_conflicted(repo, &rel)?;
    let mut args = vec!["mergetool", "--no-prompt"];
    if config_value(Some(repo), "merge.guitool").is_some() {
        args.push("--gui");
    }
    args.extend(["--", rel.as_str()]);
    run_git_stdout(workdir(repo)?, &args)?;
    snapshot(repo)
}
