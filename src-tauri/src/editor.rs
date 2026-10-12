use std::path::{Path, PathBuf};

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
    mac_paths: &'static [&'static str],
    linux_paths: &'static [&'static str],
    lines: LineStyle,
    /// Shown in Settings. IDEs stay openable when a saved preference already names them.
    listed: bool,
    windows_only: bool,
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
        mac_paths: &[
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ],
        linux_paths: &["/usr/share/code/bin/code", "/snap/bin/code"],
        lines: LineStyle::Goto,
        listed: true,
        windows_only: false,
    },
    Editor {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe"],
        mac_paths: &[
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            "~/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        ],
        linux_paths: &["/usr/share/cursor/bin/cursor", "/snap/bin/cursor"],
        lines: LineStyle::Goto,
        listed: false,
        windows_only: false,
    },
    Editor {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        commands: &["code-insiders"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe"],
        mac_paths: &[
            "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
        ],
        linux_paths: &[],
        lines: LineStyle::Goto,
        listed: false,
        windows_only: false,
    },
    Editor {
        id: "zed",
        name: "Zed",
        commands: &["zed"],
        windows_paths: &[r"%LOCALAPPDATA%\Programs\Zed\zed.exe"],
        mac_paths: &[
            "/Applications/Zed.app/Contents/MacOS/zed",
            "/Applications/Zed.app/Contents/MacOS/cli",
            "~/Applications/Zed.app/Contents/MacOS/zed",
        ],
        linux_paths: &["/usr/bin/zed"],
        lines: LineStyle::Suffix,
        listed: true,
        windows_only: false,
    },
    Editor {
        id: "sublime",
        name: "Sublime Text",
        commands: &["subl"],
        windows_paths: &[
            r"%ProgramFiles%\Sublime Text\subl.exe",
            r"%ProgramFiles%\Sublime Text 3\subl.exe",
        ],
        mac_paths: &[
            "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
            "~/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
        ],
        linux_paths: &["/opt/sublime_text/sublime_text"],
        lines: LineStyle::Suffix,
        listed: true,
        windows_only: false,
    },
    Editor {
        id: "notepad++",
        name: "Notepad++",
        commands: &["notepad++"],
        windows_paths: &[
            r"%ProgramFiles%\Notepad++\notepad++.exe",
            r"%ProgramFiles(x86)%\Notepad++\notepad++.exe",
        ],
        mac_paths: &[],
        linux_paths: &[],
        lines: LineStyle::NotepadPlusPlus,
        listed: true,
        windows_only: true,
    },
    Editor {
        id: "rider",
        name: "JetBrains Rider",
        commands: &["rider", "rider64"],
        windows_paths: &[],
        mac_paths: &["/Applications/Rider.app/Contents/MacOS/rider"],
        linux_paths: &[],
        lines: LineStyle::JetBrains,
        listed: false,
        windows_only: false,
    },
];

pub(crate) use crate::locate::which;

pub(crate) fn editor_program(id: &str) -> Option<String> {
    let editor = EDITORS.iter().find(|editor| editor.id == id)?;
    if let Some(name) = editor
        .commands
        .iter()
        .copied()
        .find(|name| which(name).is_some())
    {
        return Some(name.to_string());
    }
    locate(editor)
        .map(|path| crate::locate::quote_shell(&path.to_string_lossy().replace('\\', "/")))
        .or_else(|| editor.commands.first().map(|name| (*name).to_string()))
}

fn first_existing(templates: &[&str]) -> Option<PathBuf> {
    templates
        .iter()
        .filter_map(|template| crate::locate::expand_path(template))
        .find(|path| path.is_file())
}

fn locate(editor: &Editor) -> Option<PathBuf> {
    if cfg!(windows) {
        if let Some(path) = first_existing(editor.windows_paths) {
            return Some(path);
        }
    }
    if let Some(path) = editor.commands.iter().find_map(|command| which(command)) {
        return Some(path);
    }
    let templates: &[&str] = if cfg!(target_os = "macos") {
        editor.mac_paths
    } else if cfg!(windows) {
        &[]
    } else {
        editor.linux_paths
    };
    first_existing(templates)
}

pub fn list_editors() -> Vec<EditorOption> {
    let mut items = vec![EditorOption {
        id: "system".to_string(),
        name: "System default app".to_string(),
        available: true,
    }];
    for editor in EDITORS {
        if !editor.listed || (editor.windows_only && !cfg!(windows)) {
            continue;
        }
        items.push(EditorOption {
            id: editor.id.to_string(),
            name: editor.name.to_string(),
            available: locate(editor).is_some(),
        });
    }
    items
}

fn open_with_system(path: &str) -> AppResult<()> {
    #[cfg(windows)]
    {
        // explorer.exe treats a file path as a folder to browse. A file, or a
        // path written with `/`, makes it open its default location instead of
        // the file. ShellExecute uses the application registered for the file.
        let path = path.replace('/', "\\");
        let file = wide(&path);
        let operation = wide("open");
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if code <= 32 {
            return Err(AppError::msg(format!("Could not open {path}")));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let mut command = if cfg!(target_os = "macos") {
            let mut command = crate::locate::command("open");
            command.arg(path);
            command
        } else {
            let mut command = crate::locate::command("xdg-open");
            command.arg(path);
            command
        };
        command
            .spawn()
            .map_err(|err| AppError::msg(format!("Could not open {path}: {err}")))?;
        Ok(())
    }
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

/// Opens a file (at `line` when given) or a folder in the chosen editor.
/// "system" (and the old "auto" preference) uses the system default app.
pub fn open_in_editor(path: &str, line: Option<u32>, editor_id: &str) -> AppResult<()> {
    let path = strip_verbatim_prefix(path);
    let target = Path::new(&path);
    if !target.exists() {
        return Err(AppError::msg(format!("{path} does not exist")));
    }
    let chosen = match editor_id.trim() {
        "" | "auto" | "system" => None,
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
    let mut command = crate::locate::command(&exe);
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
    use crate::locate::expand_env;

    #[test]
    fn expands_environment_variables_in_install_paths() {
        unsafe { std::env::set_var("REBASELY_EDITOR_TEST", r"C:\Users\me") };
        assert_eq!(
            expand_env(r"%REBASELY_EDITOR_TEST%\Programs\x.exe").unwrap(),
            std::path::PathBuf::from(r"C:\Users\me\Programs\x.exe")
        );
        assert!(expand_env(r"%REBASELY_MISSING_VAR%\x.exe").is_none());
    }
}
