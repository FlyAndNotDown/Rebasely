//! Native desktop integration and background process policy.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(any(windows, test))]
use std::process::Stdio;

use crate::error::{AppError, AppResult};

// Preserve WKWebView's opaque painting path; document CSS supplies the theme.
#[cfg(target_os = "macos")]
pub(crate) fn configure_main_webview(config: &mut tauri::Config) {
    if let Some(window) = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    {
        window.background_color = None;
        window.decorations = true;
        window.title_bar_style = tauri::TitleBarStyle::Overlay;
        window.hidden_title = true;
        window.traffic_light_position =
            Some(tauri::utils::config::LogicalPosition { x: 16.0, y: 22.0 });
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn configure_main_webview(config: &mut tauri::Config) {
    if let Some(window) = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    {
        window.decorations = true;
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn configure_main_webview(_: &mut tauri::Config) {}

pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = crate::locate::command(program);
    configure_background(&mut command);
    command
}

pub(crate) fn configure_background(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub(crate) fn spawn_detached(mut command: Command) -> std::io::Result<()> {
    let mut child = command.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Only use this for children created by `background_command`.
pub(crate) fn kill_process_tree(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(windows)]
    {
        background_command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, killpg, Signal};
        use nix::unistd::Pid;
        let pid = Pid::from_raw(pid as i32);
        killpg(pid, Signal::SIGKILL).is_ok() || kill(pid, Signal::SIGKILL).is_ok()
    }
    #[cfg(not(any(windows, unix)))]
    false
}

fn existing_absolute_path(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(AppError::msg("Choose a file or folder to open."));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    // Keep the last entry intact so Reveal selects a symlink, not its target.
    std::fs::symlink_metadata(&absolute)?;
    #[cfg(windows)]
    return Ok(PathBuf::from(crate::git::strip_verbatim_prefix(
        &absolute.to_string_lossy(),
    )));
    #[cfg(not(windows))]
    Ok(absolute)
}

pub(crate) fn open_path(path: &Path) -> AppResult<()> {
    let path = existing_absolute_path(path)?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|_| {
        AppError::msg("Could not open the file or folder with its default application.")
    })
}

pub(crate) fn reveal_path(path: &Path) -> AppResult<()> {
    let path = existing_absolute_path(path)?;
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|_| AppError::msg("Could not reveal the file in the system file manager."))
}

fn allowed_url(value: &str) -> AppResult<url::Url> {
    if value.chars().any(char::is_control) {
        return Err(AppError::msg("The link is invalid."));
    }
    let parsed = url::Url::parse(value).map_err(|_| AppError::msg("The link is invalid."))?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || (parsed.scheme() != "mailto" && parsed.host_str().is_none())
    {
        return Err(AppError::msg(
            "Only web and email links without credentials can be opened.",
        ));
    }
    Ok(parsed)
}

pub(crate) fn open_url(value: &str) -> AppResult<()> {
    let parsed = allowed_url(value)?;
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| AppError::msg("Could not open the link with its default application."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_reject_executable_schemes_and_embedded_credentials() {
        for link in [
            "https://example.com/docs",
            "http://localhost/",
            "mailto:alice@example.com",
        ] {
            assert!(allowed_url(link).is_ok(), "{link}");
        }
        for link in [
            "javascript:alert(1)",
            "file:///tmp/script.sh",
            "data:text/html,content",
            "https://alice:password@example.com/repo.git",
            "https://example.com/\nnext",
            "not a URL",
        ] {
            assert!(allowed_url(link).is_err(), "{link}");
        }
    }

    #[test]
    fn native_targets_must_exist_and_resolve_to_absolute_paths() {
        let current = std::env::current_dir().unwrap();
        assert_eq!(
            existing_absolute_path(Path::new(".")).unwrap(),
            current.join(".")
        );
        assert!(existing_absolute_path(Path::new("")).is_err());
        assert!(existing_absolute_path(&current.join("missing-rebasely-native-target")).is_err());
        assert!(!kill_process_tree(0));
    }

    #[cfg(unix)]
    #[test]
    fn background_processes_have_a_cancellable_process_group() {
        use nix::unistd::{getpgid, Pid};
        let mut child = background_command("sh")
            .args(["-c", "sleep 10"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let group = getpgid(Some(Pid::from_raw(pid as i32)));
        let killed = kill_process_tree(pid);
        let _ = child.kill();
        let status = child.wait().unwrap();
        assert_eq!(group.unwrap(), Pid::from_raw(pid as i32));
        assert!(killed);
        assert!(!status.success());
    }
}
