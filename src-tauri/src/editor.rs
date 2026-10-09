use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::strip_verbatim_prefix;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorOption {
    pub id: String,
    pub name: String,
    pub available: bool,
}

/// How an editor is told which line to open at.
#[derive(Clone, Copy)]
enum LineStyle {
    /// `--goto file:line`, as VS Code and its forks take it.
    Goto,
    /// `file:line`
    Suffix,
    /// `-nLINE file`
    NotepadPlusPlus,
    /// `--line LINE file`
    JetBrains,
}

struct Editor {
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    /// Install locations under %LOCALAPPDATA% or %ProgramFiles%, checked when
    /// the editor is not on PATH.
    windows_paths: &'static [&'static str],
    lines: LineStyle,
}

const EDITORS: &[Editor] = &[
    Editor {
        id: "vscode",
        name: "Visual Studio Code",
        commands: &["code"],
        windows_paths: &[
            r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
            r"%ProgramFiles%\Microsoft VS Code\Code.exe",
        ],
        lines: LineStyle::Goto,
    },
    Editor {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe"],
        lines: LineStyle::Goto,
    },
    Editor {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        commands: &["code-insiders"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe"],
        lines: LineStyle::Goto,
    },
    Editor {
        id: "zed",
        name: "Zed",
        commands: &["zed"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\Zed\zed.exe"],
        lines: LineStyle::Suffix,
    },
    Editor {
        id: "sublime",
        name: "Sublime Text",
        commands: &["subl"],
        windows_paths: &[
            r"%ProgramFiles%\Sublime Text\subl.exe",
            r"%ProgramFiles%\Sublime Text 3\subl.exe",
        ],
        lines: LineStyle::Suffix,
    },
    Editor {
        id: "notepad++",
        name: "Notepad++",
        commands: &["notepad++"],
        windows_paths: &[
            r"%ProgramFiles%\Notepad++\notepad++.exe",
            r"%ProgramFiles(x86)%\Notepad++\notepad++.exe",
        ],
        lines: LineStyle::NotepadPlusPlus,
    },
    Editor {
        id: "rider",
        name: "JetBrains Rider",
        commands: &["rider", "rider64"],
        windows_paths: &[],
        lines: LineStyle::JetBrains,
    },
];

fn expand_env(template: &str) -> Option<PathBuf> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&std::env::var(&after[..end]).ok()?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(PathBuf::from(out))
}

fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let mut names = vec![name.to_string()];
    if cfg!(windows) {
        if let Ok(pathext) = std::env::var("PATHEXT") {
            for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
                names.push(format!("{name}{ext}"));
            }
        }
    }
    for dir in std::env::split_paths(&paths) {
        for candidate in &names {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn locate(editor: &Editor) -> Option<PathBuf> {
    if cfg!(windows) {
        let installed = editor
            .windows_paths
            .iter()
            .filter_map(|template| expand_env(template))
            .find(|path| path.is_file());
        if installed.is_some() {
            return installed;
        }
    }
    editor.commands.iter().find_map(|command| which(command))
}

pub fn list_editors() -> Vec<EditorOption> {
    let mut items = vec![EditorOption {
        id: "system".to_string(),
        name: "System default app".to_string(),
        available: true,
    }];
    for editor in EDITORS {
        items.push(EditorOption {
            id: editor.id.to_string(),
            name: editor.name.to_string(),
            available: locate(editor).is_some(),
        });
    }
    items
}

fn open_with_system(path: &str) -> AppResult<()> {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };
    command
        .spawn()
        .map_err(|err| AppError::msg(format!("Could not open {path}: {err}")))?;
    Ok(())
}

/// Opens a file (at `line` when given) or a folder in the chosen editor.
/// "auto" picks the first editor found, then falls back to the system default.
pub fn open_in_editor(path: &str, line: Option<u32>, editor_id: &str) -> AppResult<()> {
    let path = strip_verbatim_prefix(path);
    let target = Path::new(&path);
    if !target.exists() {
        return Err(AppError::msg(format!("{path} does not exist")));
    }
    let chosen = match editor_id.trim() {
        "" | "auto" => EDITORS
            .iter()
            .find_map(|editor| locate(editor).map(|exe| (editor, exe))),
        "system" => None,
        id => {
            let editor = EDITORS
                .iter()
                .find(|editor| editor.id == id)
                .ok_or_else(|| AppError::msg(format!("Unknown editor: {id}")))?;
            let exe = locate(editor).ok_or_else(|| {
                AppError::msg(format!("{} was not found on this machine", editor.name))
            })?;
            Some((editor, exe))
        }
    };
    let Some((editor, exe)) = chosen else {
        return open_with_system(&path);
    };
    let line = line.filter(|_| target.is_file());
    let mut command = Command::new(&exe);
    match (editor.lines, line) {
        (LineStyle::Goto, Some(line)) => {
            command.arg("--goto").arg(format!("{path}:{line}"));
        }
        (LineStyle::Suffix, Some(line)) => {
            command.arg(format!("{path}:{line}"));
        }
        (LineStyle::NotepadPlusPlus, Some(line)) => {
            command.arg(format!("-n{line}")).arg(&path);
        }
        (LineStyle::JetBrains, Some(line)) => {
            command.arg("--line").arg(line.to_string()).arg(&path);
        }
        (_, None) => {
            command.arg(&path);
        }
    }
    #[cfg(windows)]
    {
        // Editors found on PATH are often .cmd shims, which would flash a console.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| AppError::msg(format!("Could not start {}: {err}", editor.name)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::expand_env;

    #[test]
    fn expands_environment_variables_in_install_paths() {
        std::env::set_var("REBASELY_EDITOR_TEST", r"C:\Users\me");
        assert_eq!(
            expand_env(r"%REBASELY_EDITOR_TEST%\Programs\x.exe").unwrap(),
            std::path::PathBuf::from(r"C:\Users\me\Programs\x.exe")
        );
        assert!(expand_env(r"%REBASELY_MISSING_VAR%\x.exe").is_none());
    }
}
