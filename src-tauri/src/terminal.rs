use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::strip_verbatim_prefix;

const TERMINAL_DIRECTORY_ENV: &str = "REBASELY_TERMINAL_DIRECTORY";
const POWERSHELL_START_DIRECTORY: &str = "Set-Location -LiteralPath $env:REBASELY_TERMINAL_DIRECTORY; Remove-Item -LiteralPath 'Env:REBASELY_TERMINAL_DIRECTORY'";

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
        items.push(option("iterm", "iTerm", mac_app("iTerm")));
        items.push(option(
            "kitty",
            "Kitty",
            mac_app("kitty") || exists_in_path("kitty"),
        ));
        items.push(option(
            "ghostty",
            "Ghostty",
            mac_app("Ghostty") || exists_in_path("ghostty"),
        ));
        items.push(option(
            "wezterm",
            "WezTerm",
            mac_app("WezTerm") || exists_in_path("wezterm"),
        ));
        items.push(option("warp", "Warp", mac_app("Warp")));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (id, name, bin) in [
            ("kgx", "Console", "kgx"),
            ("ptyxis", "Ptyxis", "ptyxis"),
            ("gnome-terminal", "GNOME Terminal", "gnome-terminal"),
            ("konsole", "Konsole", "konsole"),
            ("xfce4-terminal", "Xfce Terminal", "xfce4-terminal"),
            ("mate-terminal", "MATE Terminal", "mate-terminal"),
            ("tilix", "Tilix", "tilix"),
            ("terminator", "Terminator", "terminator"),
            ("kitty", "Kitty", "kitty"),
            ("ghostty", "Ghostty", "ghostty"),
            ("wezterm", "WezTerm", "wezterm"),
            ("alacritty", "Alacritty", "alacritty"),
            ("foot", "Foot", "foot"),
            (
                "x-terminal-emulator",
                "System terminal",
                "x-terminal-emulator",
            ),
            ("xterm", "xterm", "xterm"),
        ] {
            items.push(option(id, name, exists_in_path(bin)));
        }
    }

    items
}

pub fn open_in_terminal(path: &str, terminal_id: &str) -> AppResult<()> {
    let path = if cfg!(windows) {
        strip_verbatim_prefix(path)
    } else {
        path.to_string()
    };
    if path.is_empty() || !Path::new(&path).is_dir() {
        return Err(AppError::msg("Repository folder was not found"));
    }
    let path = std::path::absolute(path)?;

    let requested = terminal_id.trim();
    let id = if requested.is_empty() || requested == "auto" {
        first_available_id()
    } else {
        requested.to_string()
    };

    if !list_terminals()
        .iter()
        .any(|terminal| terminal.id == id && terminal.available)
    {
        return Err(AppError::msg(
            "The selected terminal is unavailable. Choose an installed terminal in Settings.",
        ));
    }
    spawn_terminal(&id, &path.to_string_lossy())
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
        "x-terminal-emulator".to_string()
    }
}

fn exists_in_path(name: &str) -> bool {
    crate::locate::which(name).is_some()
}

#[cfg(target_os = "macos")]
fn mac_app(name: &str) -> bool {
    let app = format!("{name}.app");
    if Path::new("/Applications").join(&app).exists() {
        return true;
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Applications").join(app).exists())
        .unwrap_or(false)
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
    crate::locate::which("git-bash").or_else(|| {
        crate::locate::which("bash").filter(|path| {
            let text = path.to_string_lossy();
            text.contains("Git") || text.contains("git")
        })
    })
}

fn terminal_command(id: &str, path: &str, macos: bool, cli_available: bool) -> AppResult<Command> {
    let command = match id {
        "windows-terminal" => {
            let mut command = crate::locate::command("wt");
            command.args(["-d", path]);
            command
        }
        "pwsh" | "powershell" => {
            let mut command = crate::locate::command(id);
            command.args(["-NoExit", "-Command", POWERSHELL_START_DIRECTORY]);
            command.env(TERMINAL_DIRECTORY_ENV, path);
            command
        }
        "cmd" => {
            let mut command = crate::locate::command("cmd");
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
            let mut command = crate::locate::command(bash);
            if is_git_bash {
                command.arg(format!("--cd={path}"));
            } else {
                command.args(["--login", "-i"]).current_dir(path);
            }
            command
        }
        "terminal" => {
            let mut command = crate::locate::command("open");
            command.args(["-a", "Terminal", path]);
            command
        }
        "iterm" => {
            let mut command = crate::locate::command("open");
            command.args(["-a", "iTerm", path]);
            command
        }
        "warp" => {
            let mut command = crate::locate::command("open");
            command.args(["-a", "Warp", path]);
            command
        }
        "gnome-terminal" | "mate-terminal" => {
            let mut command = crate::locate::command(id);
            command.arg(format!("--working-directory={path}"));
            command
        }
        "konsole" => {
            let mut command = crate::locate::command("konsole");
            command.args(["--workdir", path]);
            command
        }
        "xfce4-terminal" | "terminator" => {
            let mut command = crate::locate::command(id);
            command.arg(format!("--working-directory={path}"));
            command
        }
        "tilix" => {
            let mut command = crate::locate::command("tilix");
            command.args(["--working-directory", path]);
            command
        }
        "kgx" | "ptyxis" => {
            let mut command = crate::locate::command(id);
            command.args(["--working-directory", path]);
            command
        }
        "kitty" => mac_or_cli(
            "kitty",
            "kitty",
            &["--directory", path],
            macos,
            cli_available,
        ),
        "ghostty" => {
            let flag = format!("--working-directory={path}");
            if macos && !cli_available {
                let mut command = crate::locate::command("open");
                command.args(["-na", "Ghostty", "--args", &flag]);
                command
            } else {
                let mut command = crate::locate::command("ghostty");
                command.arg(flag);
                command
            }
        }
        "wezterm" => mac_or_cli(
            "wezterm",
            "WezTerm",
            &["start", "--cwd", path],
            macos,
            cli_available,
        ),
        "alacritty" => {
            let mut command = crate::locate::command("alacritty");
            command.args(["--working-directory", path]);
            command
        }
        "foot" => {
            let mut command = crate::locate::command("foot");
            command.arg(format!("--working-directory={path}"));
            command
        }
        "x-terminal-emulator" | "xterm" => {
            let mut command = crate::locate::command(id);
            command.current_dir(path);
            command
        }
        other => {
            return Err(AppError::msg(format!("Unknown terminal: {other}")));
        }
    };

    Ok(command)
}

fn spawn_terminal(id: &str, path: &str) -> AppResult<()> {
    let mut command = terminal_command(id, path, cfg!(target_os = "macos"), exists_in_path(id))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }

    crate::platform::spawn_detached(command)
        .map_err(|err| AppError::msg(format!("Could not open terminal: {err}")))?;
    Ok(())
}

fn mac_or_cli(cli: &str, app: &str, args: &[&str], macos: bool, cli_available: bool) -> Command {
    if macos && !cli_available {
        let mut command = crate::locate::command("open");
        command.arg("-na").arg(app).arg("--args");
        command.args(args);
        command
    } else {
        let mut command = crate::locate::command(cli);
        command.args(args);
        command
    }
}

#[cfg(test)]
mod tests {
    use super::{
        open_in_terminal, terminal_command, POWERSHELL_START_DIRECTORY, TERMINAL_DIRECTORY_ENV,
    };
    use std::ffi::OsString;

    fn args(command: &std::process::Command) -> Vec<OsString> {
        command.get_args().map(|arg| arg.to_owned()).collect()
    }

    fn expected(values: &[&str]) -> Vec<OsString> {
        values.iter().map(|value| OsString::from(*value)).collect()
    }

    #[test]
    fn unix_terminal_directories_remain_one_literal_argument() {
        let path = "/work/client/space 'quote' $literal;name";
        for id in [
            "gnome-terminal",
            "mate-terminal",
            "xfce4-terminal",
            "terminator",
            "foot",
            "ghostty",
        ] {
            let command = terminal_command(id, path, false, true).unwrap();
            assert_eq!(
                args(&command),
                vec![OsString::from(format!("--working-directory={path}"))]
            );
        }
        for id in ["kgx", "ptyxis", "tilix", "alacritty"] {
            let command = terminal_command(id, path, false, true).unwrap();
            assert_eq!(args(&command), expected(&["--working-directory", path]));
        }
        assert_eq!(
            args(&terminal_command("konsole", path, false, true).unwrap()),
            expected(&["--workdir", path])
        );
        assert_eq!(
            args(&terminal_command("kitty", path, false, true).unwrap()),
            expected(&["--directory", path])
        );
        assert_eq!(
            args(&terminal_command("wezterm", path, false, true).unwrap()),
            expected(&["start", "--cwd", path])
        );
    }

    #[test]
    fn mac_application_fallback_keeps_terminal_arguments_after_the_separator() {
        let path = "/work/client/space 'quote' $literal";
        for (id, app, options) in [
            ("kitty", "kitty", vec!["--directory", path]),
            (
                "ghostty",
                "Ghostty",
                vec!["--working-directory=/work/client/space 'quote' $literal"],
            ),
            ("wezterm", "WezTerm", vec!["start", "--cwd", path]),
        ] {
            let command = terminal_command(id, path, true, false).unwrap();
            assert_eq!(command.get_program(), "open");
            let mut wanted = expected(&["-na", app, "--args"]);
            wanted.extend(expected(&options));
            assert_eq!(args(&command), wanted);
        }
        let command = terminal_command("kitty", path, true, true).unwrap();
        assert_eq!(command.get_program(), "kitty");
        assert_eq!(args(&command), expected(&["--directory", path]));
    }

    #[test]
    fn windows_shells_keep_directory_data_out_of_command_text() {
        let path = r"C:\work\client's folder\$literal";
        for id in ["pwsh", "powershell"] {
            for directory in [
                path,
                "C:\\work\\client\u{2018}; Write-Output example; #",
                "C:\\work\\client\u{2019}; Write-Output example; #",
                "C:\\work\\$(example); 'quoted' & literal",
            ] {
                let command = terminal_command(id, directory, false, true).unwrap();
                assert_eq!(
                    args(&command),
                    expected(&["-NoExit", "-Command", POWERSHELL_START_DIRECTORY])
                );
                assert_eq!(
                    command
                        .get_envs()
                        .find(|(key, _)| *key == TERMINAL_DIRECTORY_ENV)
                        .and_then(|(_, value)| value),
                    Some(std::ffi::OsStr::new(directory))
                );
                assert!(!POWERSHELL_START_DIRECTORY.contains(directory));
            }
        }
        let command = terminal_command("cmd", path, false, true).unwrap();
        assert_eq!(args(&command), expected(&["/K"]));
        assert_eq!(command.get_current_dir(), Some(std::path::Path::new(path)));
        assert!(terminal_command("unknown", path, false, true).is_err());
    }

    #[test]
    fn opening_a_terminal_rejects_files_before_starting_an_application() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = std::env::temp_dir().join(format!(
            "rebasely-terminal-{}-{unique}.txt",
            std::process::id()
        ));
        std::fs::write(&file, "content").unwrap();
        assert!(open_in_terminal(&file.to_string_lossy(), "auto").is_err());
        std::fs::remove_file(file).unwrap();
    }
}
