use std::ffi::OsString;
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
    let path = locate(editor)?;
    let path = path.to_string_lossy();
    let path = if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.into_owned()
    };
    Some(crate::locate::quote_shell(&path))
}

fn first_existing(templates: &[&str]) -> Option<PathBuf> {
    templates
        .iter()
        .filter_map(|template| crate::locate::expand_path(template))
        .find(|path| crate::locate::is_executable(path))
}

fn locate(editor: &Editor) -> Option<PathBuf> {
    if cfg!(windows) {
        if let Some(path) = first_existing(editor.windows_paths) {
            return Some(path);
        }
    }
    if let Some(path) = editor
        .commands
        .iter()
        .filter_map(|command| which(command))
        .find_map(|path| native_editor_program(editor.id, &path))
    {
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

fn native_editor_program(id: &str, path: &Path) -> Option<PathBuf> {
    if !cfg!(windows)
        || !path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        return Some(path.to_path_buf());
    }
    let executable = match id {
        "vscode" => "Code.exe",
        "vscode-insiders" => "Code - Insiders.exe",
        "cursor" => "Cursor.exe",
        _ => return None,
    };
    let candidate = path.parent()?.parent()?.join(executable);
    crate::locate::is_executable(&candidate).then_some(candidate)
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

pub fn open_mailto(email: &str) -> AppResult<()> {
    if !is_mail_address(email) {
        return Err(AppError::msg("Email address is invalid"));
    }
    crate::platform::open_url(&format!("mailto:{email}"))
}

fn is_mail_address(email: &str) -> bool {
    let Some((name, domain)) = email.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
        && email.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-' | b'@')
        })
}

fn open_with_system(path: &str) -> AppResult<()> {
    crate::platform::open_path(Path::new(path))
}

/// Opens a file (at `line` when given) or a folder in the chosen editor.
/// "system" (and the old "auto" preference) uses the system default app.
pub fn open_in_editor(path: &str, line: Option<u32>, editor_id: &str) -> AppResult<()> {
    let path = if cfg!(windows) {
        strip_verbatim_prefix(path)
    } else {
        path.to_string()
    };
    if path.is_empty() {
        return Err(AppError::msg("Choose a file or folder to open"));
    }
    let target = std::path::absolute(&path)?;
    if !target.exists() {
        return Err(AppError::msg("The file or folder no longer exists"));
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
        return open_with_system(&target.to_string_lossy());
    };
    let line = line.filter(|_| target.is_file());
    let mut command = crate::platform::background_command(&exe);
    command.args(editor_arguments(editor.lines, &target, line));
    crate::platform::spawn_detached(command)
        .map_err(|err| AppError::msg(format!("Could not start {}: {err}", editor.name)))?;
    Ok(())
}

fn editor_arguments(style: LineStyle, path: &Path, line: Option<u32>) -> Vec<OsString> {
    let path = path.as_os_str();
    match (style, line) {
        (LineStyle::Goto, Some(line)) => {
            let mut location = path.to_owned();
            location.push(format!(":{line}"));
            vec![OsString::from("--goto"), location]
        }
        (LineStyle::Suffix, Some(line)) => {
            let mut location = path.to_owned();
            location.push(format!(":{line}"));
            vec![location]
        }
        (LineStyle::NotepadPlusPlus, Some(line)) => {
            vec![OsString::from(format!("-n{line}")), path.to_owned()]
        }
        (LineStyle::JetBrains, Some(line)) => {
            vec![
                OsString::from("--line"),
                OsString::from(line.to_string()),
                path.to_owned(),
            ]
        }
        (_, None) => vec![path.to_owned()],
    }
}

#[cfg(test)]
mod tests {
    use super::{editor_arguments, is_mail_address, open_in_editor, LineStyle};
    use crate::locate::expand_env;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn accepts_only_a_plain_email_address() {
        assert!(is_mail_address("alice@example.com"));
        assert!(!is_mail_address("not an email"));
        assert!(!is_mail_address("mailto:alice@example.com"));
        assert!(!is_mail_address("a@b"));
        assert!(!is_mail_address("alice@@example.com"));
        assert!(!is_mail_address(""));
    }

    #[test]
    fn editor_arguments_keep_paths_literal_for_every_line_style() {
        let path = Path::new("/work/client/file 'with' $literal.txt");
        let expected = |items: &[&str]| {
            items
                .iter()
                .map(|item| OsString::from(*item))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            editor_arguments(LineStyle::Goto, path, Some(42)),
            expected(&["--goto", "/work/client/file 'with' $literal.txt:42"])
        );
        assert_eq!(
            editor_arguments(LineStyle::Suffix, path, Some(42)),
            expected(&["/work/client/file 'with' $literal.txt:42"])
        );
        assert_eq!(
            editor_arguments(LineStyle::NotepadPlusPlus, path, Some(42)),
            expected(&["-n42", "/work/client/file 'with' $literal.txt"])
        );
        assert_eq!(
            editor_arguments(LineStyle::JetBrains, path, Some(42)),
            expected(&["--line", "42", "/work/client/file 'with' $literal.txt"])
        );
        for style in [
            LineStyle::Goto,
            LineStyle::Suffix,
            LineStyle::NotepadPlusPlus,
            LineStyle::JetBrains,
        ] {
            assert_eq!(
                editor_arguments(style, path, None),
                vec![path.as_os_str().to_owned()]
            );
        }
    }

    #[test]
    fn an_empty_editor_target_does_not_open_the_current_directory() {
        assert!(open_in_editor("", None, "system").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_editor_shims_resolve_to_the_native_executable() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("rebasely-editor-{}-{unique}", std::process::id()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("code.cmd");
        std::fs::write(&shim, "@echo off\n").unwrap();
        assert!(super::native_editor_program("vscode", &shim).is_none());
        let native = root.join("Code.exe");
        std::fs::write(&native, "test executable").unwrap();
        assert_eq!(super::native_editor_program("vscode", &shim), Some(native));
        std::fs::remove_dir_all(root).unwrap();
    }

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
