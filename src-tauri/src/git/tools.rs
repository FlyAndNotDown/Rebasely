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
    let mut chars = cmd.trim_start().chars().peekable();
    let mut word = String::new();
    let mut quote = None;
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), _) => word.push(ch),
            (Some('"'), '$' | '`') => return None,
            (Some('"'), '\\') => {
                if chars
                    .peek()
                    .is_some_and(|next| matches!(next, '$' | '`' | '"' | '\\'))
                {
                    word.push(chars.next()?);
                } else {
                    word.push(ch);
                }
            }
            (Some('"'), _) => word.push(ch),
            (None, '\'' | '"') => quote = Some(ch),
            (None, '\\') => word.push(chars.next()?),
            (None, ch) if ch.is_whitespace() => break,
            (None, '$' | '`' | ';' | '|' | '&' | '<' | '>' | '(' | ')') => return None,
            (None, _) => word.push(ch),
            _ => return None,
        }
    }
    (quote.is_none() && !word.is_empty()).then_some(word)
}

fn looks_like_path(value: &str) -> bool {
    value.contains('\\') || value.contains('/') || Path::new(value).is_file()
}

fn tool_value(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
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
    for id in ["vscode", "cursor"] {
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
            config_set_file(&path, &format!("mergetool.{id}.trustExitCode"), "true")?;
        }
    }
    Ok(read_tool_config(None))
}

fn launch_commands(id: &str) -> Option<(String, String)> {
    if !matches!(id, "vscode" | "cursor") {
        return None;
    }
    let program = crate::editor::editor_program(id)?;
    Some((
        format!("{program} --wait --diff \"$LOCAL\" \"$REMOTE\""),
        format!("{program} --wait --merge \"$REMOTE\" \"$LOCAL\" \"$BASE\" \"$MERGED\""),
    ))
}

fn quote_git_program(path: &Path) -> String {
    let path = path.to_string_lossy();
    let path = if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.into_owned()
    };
    crate::locate::quote_shell(&path)
}

/// Writes one tool. A filesystem path becomes a private tool name plus the command
/// git needs to launch that executable; a bare name is stored as git expects it.
fn assign_tool(path: &Path, kind: &str, value: &str) -> AppResult<()> {
    let value = tool_value(value);
    let key = format!("{kind}.tool");
    config_unset_file(path, &format!("{kind}.guitool"))?;
    if value.is_empty() {
        config_unset_file(path, &key)?;
        return Ok(());
    }
    if !looks_like_path(value) {
        config_set_file(path, &key, value)?;
        configure_builtin_tool(path, kind, value)?;
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
        &format!("{} {args}", quote_git_program(Path::new(value))),
    )?;
    if kind == "merge" {
        config_set_file(path, &format!("mergetool.{name}.trustExitCode"), "true")?;
    }
    Ok(())
}

/// Let Git adapt known tools to their installed version and platform. Only
/// bind the executable location; arbitrary user-provided commands remain intact.
fn configure_builtin_tool(path: &Path, kind: &str, id: &str) -> AppResult<()> {
    if matches!(id, "vscode" | "cursor") {
        return Ok(());
    }
    let Some(tool) = GUI_TOOLS.iter().find(|tool| tool.id == id) else {
        return Ok(());
    };
    let path_key = format!("{kind}tool.{id}.path");
    let cmd_key = format!("{kind}tool.{id}.cmd");
    let legacy_program = config_get_file(path, &cmd_key).and_then(|command| {
        let program = path_from_cmd(&command)?;
        let args = legacy_tool_args(id, kind)?;
        (Path::new(&program).is_absolute()
            && (command == format!("{} {args}", quote_git_program(Path::new(&program)))
                || command == format!("\"{program}\" {args}")))
        .then_some(program)
    });
    if config_get_file(path, &path_key).is_none() {
        if let Some(program) = legacy_program.as_deref() {
            config_set_file(path, &path_key, program)?;
        } else if let Some(program) =
            gui_tool_path(tool).or_else(|| tool.commands.iter().find_map(|name| which(name)))
        {
            config_set_file(path, &path_key, &program.to_string_lossy())?;
        }
    }
    if legacy_program.is_some() {
        config_unset_file(path, &cmd_key)?;
    }
    Ok(())
}

fn legacy_tool_args(id: &str, kind: &str) -> Option<&'static str> {
    match (id, kind) {
        ("araxis", "diff") => Some("-wait \"$LOCAL\" \"$REMOTE\""),
        ("araxis", "merge") => {
            Some("-wait -merge -3 -a1 \"$BASE\" \"$LOCAL\" \"$REMOTE\" \"$MERGED\"")
        }
        ("bc" | "meld" | "p4merge", "diff") => Some("\"$LOCAL\" \"$REMOTE\""),
        ("bc", "merge") => Some("\"$LOCAL\" \"$REMOTE\" \"$BASE\" \"$MERGED\""),
        ("kdiff3", "diff") => Some("--auto \"$LOCAL\" \"$REMOTE\""),
        ("kdiff3", "merge") => Some("--auto \"$BASE\" \"$LOCAL\" \"$REMOTE\" -o \"$MERGED\""),
        ("meld", "merge") => Some("\"$LOCAL\" \"$BASE\" \"$REMOTE\" --output \"$MERGED\""),
        ("p4merge", "merge") => Some("\"$BASE\" \"$LOCAL\" \"$REMOTE\" \"$MERGED\""),
        ("smerge", "diff") => Some("diff --wait \"$LOCAL\" \"$REMOTE\""),
        ("smerge", "merge") => Some("mergetool \"$BASE\" \"$LOCAL\" \"$REMOTE\" -o \"$MERGED\""),
        _ => None,
    }
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
        .find(|path| crate::locate::is_executable(path))
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
    let value = tool_value(value);
    if value.is_empty() {
        return true;
    }
    if let Some(tool) = GUI_TOOLS.iter().find(|tool| tool.id == value) {
        return gui_tool_installed(tool);
    }
    if crate::locate::is_executable(Path::new(value)) {
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
    use super::{
        assign_tool, config_get_file, config_set_file, path_from_cmd, quote_git_program,
        CUSTOM_DIFF,
    };

    fn test_config(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rebasely-tool-{label}-{}-{unique}.gitconfig",
            std::process::id()
        ));
        std::fs::write(&path, "").unwrap();
        path
    }

    #[test]
    fn reads_the_executable_out_of_a_tool_command() {
        assert_eq!(
            path_from_cmd(r#""C:\Tools\BCompare.exe" "$LOCAL" "$REMOTE""#).as_deref(),
            Some(r"C:\Tools\BCompare.exe")
        );
    }

    #[test]
    fn stores_a_custom_executable_as_its_own_tool() {
        let path = test_config("custom");
        let exe = std::env::current_exe().unwrap();
        let exe = exe.to_string_lossy().to_string();
        {
            assign_tool(&path, "diff", &exe).unwrap();
            assign_tool(&path, "merge", "kdiff3").unwrap();
            assert_eq!(
                config_get_file(&path, "diff.tool").as_deref(),
                Some(CUSTOM_DIFF)
            );
            let command = config_get_file(&path, "difftool.rebasely-diff.cmd").unwrap();
            let expected = if cfg!(windows) {
                exe.replace('\\', "/")
            } else {
                exe.clone()
            };
            assert_eq!(path_from_cmd(&command), Some(expected));
            assert_eq!(
                config_get_file(&path, "merge.tool").as_deref(),
                Some("kdiff3")
            );
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn custom_tool_paths_are_quoted_as_literal_shell_words() {
        for path in [
            "/work/tools/Tool App/tool",
            "/work/tools/quote's/tool",
            "/work/tools/double\"quote/tool",
            "/work/tools/$(ignored)/`literal`",
            "/work/tools/name\\with-backslash",
        ] {
            let command = format!(
                "{} \"$LOCAL\" \"$REMOTE\"",
                quote_git_program(std::path::Path::new(path))
            );
            let expected = if cfg!(windows) {
                path.replace('\\', "/")
            } else {
                path.to_string()
            };
            assert_eq!(path_from_cmd(&command), Some(expected));
        }
        assert!(path_from_cmd("\"$HOME/tool\" \"$LOCAL\"").is_none());
        assert!(path_from_cmd("'unterminated").is_none());
    }

    #[test]
    fn saving_a_tool_clears_the_gui_override_that_would_hide_the_selection() {
        let path = test_config("override");
        config_set_file(&path, "diff.guitool", "meld").unwrap();
        assign_tool(&path, "diff", "kdiff3").unwrap();
        assert_eq!(
            config_get_file(&path, "diff.tool").as_deref(),
            Some("kdiff3")
        );
        assert!(config_get_file(&path, "diff.guitool").is_none());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn known_tools_use_git_adapters_and_only_migrate_generated_commands() {
        let program = std::env::temp_dir().join("example custom tools/Sublime Merge/smerge");
        let double_quoted = format!("\"{}\"", program.to_string_lossy().replace('\\', "/"));
        for quoted in [quote_git_program(&program), double_quoted] {
            let path = test_config("adapter");
            let generated = format!("{quoted} diff --wait \"$LOCAL\" \"$REMOTE\"");
            config_set_file(&path, "difftool.smerge.cmd", &generated).unwrap();
            assign_tool(&path, "diff", "smerge").unwrap();
            assert!(config_get_file(&path, "difftool.smerge.cmd").is_none());
            assert_eq!(
                config_get_file(&path, "difftool.smerge.path"),
                path_from_cmd(&generated)
            );

            let custom = format!("{quoted} --custom \"$LOCAL\" \"$REMOTE\"");
            config_set_file(&path, "difftool.smerge.cmd", &custom).unwrap();
            assign_tool(&path, "diff", "smerge").unwrap();
            assert_eq!(config_get_file(&path, "difftool.smerge.cmd"), Some(custom));
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn generated_commands_without_an_absolute_executable_remain_intact() {
        let path = test_config("relative-adapter");
        let configured_program = std::env::temp_dir().join("example-tools/smerge");
        config_set_file(
            &path,
            "difftool.smerge.path",
            &configured_program.to_string_lossy(),
        )
        .unwrap();
        for command in [
            format!(
                "{} diff --wait \"$LOCAL\" \"$REMOTE\"",
                quote_git_program(std::path::Path::new("relative/tools/smerge"))
            ),
            "\"$HOME/tools/smerge\" diff --wait \"$LOCAL\" \"$REMOTE\"".to_string(),
            "\"/work/$(example)/smerge\" diff --wait \"$LOCAL\" \"$REMOTE\"".to_string(),
            "\"/work/`example`/smerge\" diff --wait \"$LOCAL\" \"$REMOTE\"".to_string(),
        ] {
            config_set_file(&path, "difftool.smerge.cmd", &command).unwrap();
            assign_tool(&path, "diff", "smerge").unwrap();
            assert_eq!(config_get_file(&path, "difftool.smerge.cmd"), Some(command));
            assert_eq!(
                config_get_file(&path, "difftool.smerge.path"),
                Some(configured_program.to_string_lossy().into_owned())
            );
        }
        std::fs::remove_file(path).unwrap();
    }
}
