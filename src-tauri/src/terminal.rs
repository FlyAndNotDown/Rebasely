use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::strip_verbatim_prefix;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOption {
    pub id: String,
    pub name: String,
    pub available: bool,
}

pub fn list_terminals() -> Vec<TerminalOption> {
    let mut items = vec![option("auto", "System default", true)];

    #[cfg(windows)]
    {
        items.push(option(
            "windows-terminal",
            "Windows Terminal",
            exists_in_path("wt"),
        ));
        items.push(option("pwsh", "PowerShell 7", exists_in_path("pwsh")));
        items.push(option(
            "powershell",
            "Windows PowerShell",
            exists_in_path("powershell"),
        ));
        items.push(option("cmd", "Command Prompt", true));
        items.push(option("git-bash", "Git Bash", git_bash_path().is_some()));
    }

    #[cfg(target_os = "macos")]
    {
        items.push(option("terminal", "Terminal", true));
        items.push(option(
            "iterm",
            "iTerm",
            Path::new("/Applications/iTerm.app").exists(),
        ));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (id, name, bin) in [
            ("gnome-terminal", "GNOME Terminal", "gnome-terminal"),
            ("konsole", "Konsole", "konsole"),
            ("xfce4-terminal", "Xfce Terminal", "xfce4-terminal"),
            ("tilix", "Tilix", "tilix"),
            ("kitty", "Kitty", "kitty"),
            ("alacritty", "Alacritty", "alacritty"),
            ("xterm", "xterm", "xterm"),
        ] {
            items.push(option(id, name, exists_in_path(bin)));
        }
    }

    items
}

pub fn open_in_terminal(path: &str, terminal_id: &str) -> AppResult<()> {
    let path = strip_verbatim_prefix(path);
    if path.is_empty() || !Path::new(&path).exists() {
        return Err(AppError::msg("Repository folder was not found"));
    }

    let requested = terminal_id.trim();
    let id = if requested.is_empty() || requested == "auto" {
        first_available_id()
    } else {
        requested.to_string()
    };

    spawn_terminal(&id, &path)
}

fn option(id: &str, name: &str, available: bool) -> TerminalOption {
    TerminalOption {
        id: id.to_string(),
        name: name.to_string(),
        available,
    }
}

fn first_available_id() -> String {
    list_terminals()
        .into_iter()
        .find(|item| item.id != "auto" && item.available)
        .map(|item| item.id)
        .unwrap_or_else(platform_fallback)
}

fn platform_fallback() -> String {
    if cfg!(windows) {
        "powershell".to_string()
    } else if cfg!(target_os = "macos") {
        "terminal".to_string()
    } else {
        "xterm".to_string()
    }
}

fn exists_in_path(name: &str) -> bool {
    which(name).is_some()
}

fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let mut names = vec![name.to_string()];
    if !name.contains('.') {
        if let Ok(pathext) = std::env::var("PATHEXT") {
            for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
                names.push(format!("{name}{ext}"));
            }
        }
    }
    for dir in std::env::split_paths(&paths) {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn git_bash_path() -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\Git\git-bash.exe",
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\git-bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for candidate in CANDIDATES {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    which("git-bash").or_else(|| {
        which("bash").filter(|path| {
            let text = path.to_string_lossy();
            text.contains("Git") || text.contains("git")
        })
    })
}

fn spawn_terminal(id: &str, path: &str) -> AppResult<()> {
    let mut command = match id {
        "windows-terminal" => {
            let mut command = Command::new("wt");
            command.args(["-d", path]);
            command
        }
        "pwsh" => {
            let mut command = Command::new("pwsh");
            command.args([
                "-NoExit",
                "-Command",
                &format!("Set-Location -LiteralPath '{}'", escape_ps(path)),
            ]);
            command
        }
        "powershell" => {
            let mut command = Command::new("powershell");
            command.args([
                "-NoExit",
                "-Command",
                &format!("Set-Location -LiteralPath '{}'", escape_ps(path)),
            ]);
            command
        }
        "cmd" => {
            let mut command = Command::new("cmd");
            command.arg("/K").current_dir(path);
            command
        }
        "git-bash" => {
            let bash = git_bash_path()
                .ok_or_else(|| AppError::msg("Git Bash was not found on this machine"))?;
            let is_git_bash = bash
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("git-bash.exe"));
            let mut command = Command::new(bash);
            if is_git_bash {
                command.arg(format!("--cd={path}"));
            } else {
                command.args(["--login", "-i"]).current_dir(path);
            }
            command
        }
        "terminal" => {
            let mut command = Command::new("open");
            command.args(["-a", "Terminal", path]);
            command
        }
        "iterm" => {
            let mut command = Command::new("open");
            command.args(["-a", "iTerm", path]);
            command
        }
        "gnome-terminal" => {
            let mut command = Command::new("gnome-terminal");
            command.arg(format!("--working-directory={path}"));
            command
        }
        "konsole" => {
            let mut command = Command::new("konsole");
            command.args(["--workdir", path]);
            command
        }
        "xfce4-terminal" => {
            let mut command = Command::new("xfce4-terminal");
            command.arg(format!("--working-directory={path}"));
            command
        }
        "tilix" => {
            let mut command = Command::new("tilix");
            command.args(["--working-directory", path]);
            command
        }
        "kitty" => {
            let mut command = Command::new("kitty");
            command.args(["--directory", path]);
            command
        }
        "alacritty" => {
            let mut command = Command::new("alacritty");
            command.args(["--working-directory", path]);
            command
        }
        "xterm" => {
            let mut command = Command::new("xterm");
            command.current_dir(path);
            command
        }
        other => {
            return Err(AppError::msg(format!("Unknown terminal: {other}")));
        }
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }

    command
        .spawn()
        .map_err(|err| AppError::msg(format!("Could not open terminal: {err}")))?;
    Ok(())
}

fn escape_ps(path: &str) -> String {
    path.replace('\'', "''")
}
