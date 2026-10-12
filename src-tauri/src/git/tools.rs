use super::*;

/// git's id for the empty tree, the "parent" of a root commit.
pub(super) const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfig {
    pub diff_tool: String,
    pub merge_tool: String,
}

fn config_value(repo: Option<&Repository>, key: &str) -> Option<String> {
    match repo {
        Some(repo) => config_get(repo, key),
        None => config_get_global(key).or_else(|| config_get_system(key)),
    }
}

/// The tools git would use, GUI variants first, as this repository sees them.
/// A custom executable saved as `rebasely-diff` / `rebasely-merge` comes back as the path.
pub fn read_tool_config(repo: Option<&Repository>) -> ToolConfig {
    ToolConfig {
        diff_tool: shown_tool(
            repo,
            "diff",
            config_value(repo, "diff.guitool")
                .or_else(|| config_value(repo, "diff.tool"))
                .unwrap_or_default(),
        ),
        merge_tool: shown_tool(
            repo,
            "merge",
            config_value(repo, "merge.guitool")
                .or_else(|| config_value(repo, "merge.tool"))
                .unwrap_or_default(),
        ),
    }
}

const CUSTOM_DIFF: &str = "rebasely-diff";
const CUSTOM_MERGE: &str = "rebasely-merge";

fn shown_tool(repo: Option<&Repository>, kind: &str, name: String) -> String {
    let custom = if kind == "diff" {
        CUSTOM_DIFF
    } else {
        CUSTOM_MERGE
    };
    if name != custom {
        return name;
    }
    config_value(repo, &format!("{kind}tool.{custom}.cmd"))
        .as_deref()
        .and_then(path_from_cmd)
        .unwrap_or(name)
}

fn path_from_cmd(cmd: &str) -> Option<String> {
    let rest = cmd.trim().strip_prefix('"')?;
    let end = rest.find('"')?;
    let path = &rest[..end];
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn looks_like_path(value: &str) -> bool {
    value.contains('\\') || value.contains('/') || Path::new(value).is_file()
}

/// Saves the tools to the global Git config. Choosing an editor that git does
/// not know adds the command it needs unless one is already set. A tool found
/// only as an application bundle gets that executable path, because the short
/// name would not be on `PATH`.
pub fn write_tool_config(config: &ToolConfig) -> AppResult<ToolConfig> {
    let path = global_gitconfig_path()?;
    if !path.exists() {
        fs::write(&path, "")?;
    }
    assign_tool(&path, "diff", &config.diff_tool)?;
    assign_tool(&path, "merge", &config.merge_tool)?;
    for id in [
        "vscode", "cursor", "araxis", "bc", "kdiff3", "meld", "p4merge", "smerge",
    ] {
        let Some((diff_cmd, merge_cmd)) = launch_commands(id) else {
            continue;
        };
        if config.diff_tool.trim() == id
            && config_get_file(&path, &format!("difftool.{id}.cmd")).is_none()
        {
            config_set_file(&path, &format!("difftool.{id}.cmd"), &diff_cmd)?;
        }
        if config.merge_tool.trim() == id
            && config_get_file(&path, &format!("mergetool.{id}.cmd")).is_none()
        {
            config_set_file(&path, &format!("mergetool.{id}.cmd"), &merge_cmd)?;
            if matches!(id, "vscode" | "cursor" | "araxis") {
                config_set_file(&path, &format!("mergetool.{id}.trustExitCode"), "true")?;
            }
        }
    }
    Ok(read_tool_config(None))
}

fn launch_commands(id: &str) -> Option<(String, String)> {
    let program = explicit_program(id)?;
    let (diff_args, merge_args) = match id {
        "vscode" | "cursor" => (
            "--wait --diff \"$LOCAL\" \"$REMOTE\"",
            "--wait --merge \"$REMOTE\" \"$LOCAL\" \"$BASE\" \"$MERGED\"",
        ),
        "araxis" => (
            "-wait \"$LOCAL\" \"$REMOTE\"",
            "-wait -merge -3 -a1 \"$BASE\" \"$LOCAL\" \"$REMOTE\" \"$MERGED\"",
        ),
        "bc" => (
            "\"$LOCAL\" \"$REMOTE\"",
            "\"$LOCAL\" \"$REMOTE\" \"$BASE\" \"$MERGED\"",
        ),
        "kdiff3" => (
            "--auto \"$LOCAL\" \"$REMOTE\"",
            "--auto \"$BASE\" \"$LOCAL\" \"$REMOTE\" -o \"$MERGED\"",
        ),
        "meld" => (
            "\"$LOCAL\" \"$REMOTE\"",
            "\"$LOCAL\" \"$BASE\" \"$REMOTE\" --output \"$MERGED\"",
        ),
        "p4merge" => (
            "\"$LOCAL\" \"$REMOTE\"",
            "\"$BASE\" \"$LOCAL\" \"$REMOTE\" \"$MERGED\"",
        ),
        "smerge" => (
            "diff --wait \"$LOCAL\" \"$REMOTE\"",
            "mergetool \"$BASE\" \"$LOCAL\" \"$REMOTE\" -o \"$MERGED\"",
        ),
        _ => return None,
    };
    Some((
        format!("{program} {diff_args}"),
        format!("{program} {merge_args}"),
    ))
}

/// `code` when that command is on PATH. Otherwise the application bundle, quoted
/// for the shell Git uses to launch a tool. Git already knows the other tools,
/// so those only need a command when the short name cannot be found.
fn explicit_program(id: &str) -> Option<String> {
    match id {
        "vscode" | "cursor" => crate::editor::editor_program(id),
        "araxis" | "bc" | "kdiff3" | "meld" | "p4merge" | "smerge" => {
            let tool = GUI_TOOLS.iter().find(|tool| tool.id == id)?;
            if tool.commands.iter().any(|name| which(name).is_some()) {
                return None;
            }
            gui_tool_path(tool).map(|path| quote_git_program(&path))
        }
        _ => None,
    }
}

fn quote_git_program(path: &Path) -> String {
    crate::locate::quote_shell(&path.to_string_lossy().replace('\\', "/"))
}

/// Writes one tool. A filesystem path becomes a private tool name plus the command
/// git needs to launch that executable; a bare name is stored as git expects it.
fn assign_tool(path: &Path, kind: &str, value: &str) -> AppResult<()> {
    let value = value.trim().trim_matches('"');
    let key = format!("{kind}.tool");
    if value.is_empty() {
        config_unset_file(path, &key)?;
        return Ok(());
    }
    if !looks_like_path(value) {
        config_set_file(path, &key, value)?;
        return Ok(());
    }
    let name = if kind == "diff" {
        CUSTOM_DIFF
    } else {
        CUSTOM_MERGE
    };
    let args = if kind == "diff" {
        r#""$LOCAL" "$REMOTE""#
    } else {
        r#""$BASE" "$LOCAL" "$REMOTE" "$MERGED""#
    };
    config_set_file(path, &key, name)?;
    config_set_file(
        path,
        &format!("{kind}tool.{name}.cmd"),
        &format!("\"{value}\" {args}"),
    )?;
    if kind == "merge" {
        config_set_file(path, &format!("mergetool.{name}.trustExitCode"), "true")?;
    }
    Ok(())
}

struct GuiTool {
    /// Git's built-in difftool/mergetool name, or `vscode` which we configure ourselves.
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    windows_paths: &'static [&'static str],
    mac_paths: &'static [&'static str],
    linux_paths: &'static [&'static str],
    windows_only: bool,
}

const GUI_TOOLS: &[GuiTool] = &[
    GuiTool {
        id: "vscode",
        name: "Visual Studio Code",
        commands: &["code"],
        windows_paths: &[
            r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
            r"%ProgramFiles%\Microsoft VS Code\Code.exe",
        ],
        mac_paths: &[
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ],
        linux_paths: &["/usr/share/code/bin/code", "/snap/bin/code"],
        windows_only: false,
    },
    GuiTool {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe"],
        mac_paths: &[
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            "~/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        ],
        linux_paths: &["/usr/share/cursor/bin/cursor", "/snap/bin/cursor"],
        windows_only: false,
    },
    GuiTool {
        id: "bc",
        name: "Beyond Compare",
        commands: &["BCompare", "bcomp", "bcompare"],
        windows_paths: &[
            r"%ProgramFiles%\Beyond Compare 5\BCompare.exe",
            r"%ProgramFiles%\Beyond Compare 4\BCompare.exe",
            r"%ProgramFiles%\Beyond Compare 3\BComp.exe",
        ],
        mac_paths: &["/Applications/Beyond Compare.app/Contents/MacOS/BCompare"],
        linux_paths: &["/usr/bin/bcompare"],
        windows_only: false,
    },
    GuiTool {
        id: "kdiff3",
        name: "KDiff3",
        commands: &["kdiff3"],
        windows_paths: &[
            r"%ProgramFiles%\KDiff3\kdiff3.exe",
            r"%LOCALAPPDATA%\Programs\KDiff3\kdiff3.exe",
        ],
        mac_paths: &["/Applications/kdiff3.app/Contents/MacOS/kdiff3"],
        linux_paths: &["/usr/bin/kdiff3"],
        windows_only: false,
    },
    GuiTool {
        id: "meld",
        name: "Meld",
        commands: &["meld"],
        windows_paths: &[
            r"%ProgramFiles%\Meld\Meld.exe",
            r"%LOCALAPPDATA%\Programs\Meld\Meld.exe",
        ],
        mac_paths: &["/Applications/Meld.app/Contents/MacOS/Meld"],
        linux_paths: &["/usr/bin/meld"],
        windows_only: false,
    },
    GuiTool {
        id: "p4merge",
        name: "P4Merge",
        commands: &["p4merge"],
        windows_paths: &[r"%ProgramFiles%\Perforce\p4merge.exe"],
        mac_paths: &[
            "/Applications/p4merge.app/Contents/Resources/bin/p4merge",
            "/Applications/p4merge.app/Contents/MacOS/p4merge",
        ],
        linux_paths: &["/opt/p4v/bin/p4merge", "/usr/bin/p4merge"],
        windows_only: false,
    },
    GuiTool {
        id: "winmerge",
        name: "WinMerge",
        commands: &["WinMergeU"],
        windows_paths: &[r"%ProgramFiles%\WinMerge\WinMergeU.exe"],
        mac_paths: &[],
        linux_paths: &[],
        windows_only: true,
    },
    GuiTool {
        id: "tortoisemerge",
        name: "Tortoise Merge",
        commands: &["TortoiseGitMerge"],
        windows_paths: &[
            r"%ProgramFiles%\TortoiseGit\bin\TortoiseGitMerge.exe",
            r"%ProgramFiles%\TortoiseSVN\bin\TortoiseMerge.exe",
        ],
        mac_paths: &[],
        linux_paths: &[],
        windows_only: true,
    },
    GuiTool {
        id: "smerge",
        name: "Sublime Merge",
        commands: &["smerge"],
        windows_paths: &[r"%ProgramFiles%\Sublime Merge\smerge.exe"],
        mac_paths: &["/Applications/Sublime Merge.app/Contents/SharedSupport/bin/smerge"],
        linux_paths: &["/opt/sublime_merge/smerge", "/usr/bin/smerge"],
        windows_only: false,
    },
    GuiTool {
        id: "araxis",
        name: "Araxis Merge",
        commands: &["compare"],
        windows_paths: &[r"%ProgramFiles%\Araxis\Araxis Merge\Compare.exe"],
        mac_paths: &["/Applications/Araxis Merge.app/Contents/Utilities/compare"],
        linux_paths: &[],
        windows_only: false,
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiToolOption {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

fn gui_tool_path(tool: &GuiTool) -> Option<PathBuf> {
    let templates: &[&str] = if cfg!(windows) {
        tool.windows_paths
    } else if cfg!(target_os = "macos") {
        tool.mac_paths
    } else {
        tool.linux_paths
    };
    templates
        .iter()
        .filter_map(|template| crate::locate::expand_path(template))
        .find(|path| path.is_file())
}

fn gui_tool_installed(tool: &GuiTool) -> bool {
    if tool.windows_only && !cfg!(windows) {
        return false;
    }
    gui_tool_path(tool).is_some() || tool.commands.iter().any(|command| which(command).is_some())
}

pub fn list_gui_tools() -> Vec<GuiToolOption> {
    GUI_TOOLS
        .iter()
        .filter(|tool| cfg!(windows) || !tool.windows_only)
        .map(|tool| GuiToolOption {
            id: tool.id.to_string(),
            name: tool.name.to_string(),
            installed: gui_tool_installed(tool),
        })
        .collect()
}

/// True when `value` is empty, a known installed tool, a command on PATH, or an existing file.
pub fn gui_tool_found(value: &str) -> bool {
    let value = value.trim().trim_matches('"');
    if value.is_empty() {
        return true;
    }
    if let Some(tool) = GUI_TOOLS.iter().find(|tool| tool.id == value) {
        return gui_tool_installed(tool);
    }
    if Path::new(value).is_file() {
        return true;
    }
    if !looks_like_path(value) {
        return crate::editor::which(value).is_some();
    }
    false
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

#[cfg(test)]
mod tests {
    use super::{assign_tool, config_get_file, path_from_cmd, CUSTOM_DIFF};

    #[test]
    fn reads_the_executable_out_of_a_tool_command() {
        assert_eq!(
            path_from_cmd(r#""C:\Tools\BCompare.exe" "$LOCAL" "$REMOTE""#).as_deref(),
            Some(r"C:\Tools\BCompare.exe")
        );
    }

    #[test]
    fn stores_a_custom_executable_as_its_own_tool() {
        let path =
            std::env::temp_dir().join(format!("rebasely-tool-{}.gitconfig", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, "").unwrap();
        let exe = std::env::current_exe().unwrap();
        let exe = exe.to_string_lossy().to_string();
        {
            assign_tool(&path, "diff", &exe).unwrap();
            assign_tool(&path, "merge", "kdiff3").unwrap();
            assert_eq!(
                config_get_file(&path, "diff.tool").as_deref(),
                Some(CUSTOM_DIFF)
            );
            assert!(config_get_file(&path, "difftool.rebasely-diff.cmd")
                .unwrap()
                .contains(&exe));
            assert_eq!(
                config_get_file(&path, "merge.tool").as_deref(),
                Some("kdiff3")
            );
        }
        let _ = std::fs::remove_file(&path);
    }
}
