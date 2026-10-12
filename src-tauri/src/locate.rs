//! Finds executables the same way a terminal would.
//!
//! A macOS app launched from the Dock inherits a short `PATH` that does not
//! include Homebrew. Linux sessions usually have a full `PATH`, but tools
//! installed under the home directory or by Snap are easy to miss.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
use std::process::Stdio;
#[cfg(target_os = "macos")]
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::time::Duration;

struct SearchPath {
    dirs: Vec<PathBuf>,
    /// True when `dirs` adds locations that the process `PATH` did not have.
    extended: bool,
}

pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
}

/// `PATH` for a child when we know about directories the parent process does not.
pub(crate) fn child_path() -> Option<OsString> {
    let search = search_path();
    if !search.extended {
        return None;
    }
    std::env::join_paths(&search.dirs).ok()
}

pub(crate) fn which(name: &str) -> Option<PathBuf> {
    let mut names = vec![name.to_string()];
    let pathext = if name.contains('.') {
        None
    } else {
        std::env::var("PATHEXT").ok()
    };
    if let Some(pathext) = pathext {
        for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
            names.push(format!("{name}{ext}"));
        }
    }
    for dir in &search_path().dirs {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if candidate.is_file() {
                return Some(on_disk_name(candidate));
            }
        }
    }
    None
}

/// Quotes one shell word, for `sh -c` and for Git tool commands.
pub(crate) fn quote_shell(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Expands `~/...` and `%VAR%` install paths.
pub(crate) fn expand_path(template: &str) -> Option<PathBuf> {
    if let Some(rest) = template.strip_prefix("~/") {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        return expand_env(&PathBuf::from(home).join(rest).to_string_lossy());
    }
    expand_env(template)
}

pub(crate) fn expand_env(template: &str) -> Option<PathBuf> {
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

/// Windows treats `git.EXE` and `git.exe` as the same file, and `PATHEXT` is
/// uppercase, so the probe path is not the name stored on disk.
pub(crate) fn on_disk_name(candidate: PathBuf) -> PathBuf {
    let Some(wanted) = candidate.file_name() else {
        return candidate;
    };
    let Some(dir) = candidate.parent() else {
        return candidate;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return candidate;
    };
    for entry in entries.flatten() {
        if entry.file_name().eq_ignore_ascii_case(wanted) {
            return dir.join(entry.file_name());
        }
    }
    candidate
}

fn search_path() -> &'static SearchPath {
    static PATH: OnceLock<SearchPath> = OnceLock::new();
    PATH.get_or_init(build_search_path)
}

fn build_search_path() -> SearchPath {
    let original: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let mut dirs = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(path) = login_shell_path() {
        for dir in std::env::split_paths(&path) {
            push_unique(&mut dirs, dir);
        }
    }
    for dir in &original {
        push_unique(&mut dirs, dir.clone());
    }
    for dir in fallback_bin_dirs() {
        push_unique(&mut dirs, dir);
    }
    // Dropping duplicates or empty entries is not a new search location.
    // Windows keeps the process PATH unless a directory was actually added.
    let extended = dirs
        .iter()
        .any(|dir| !original.iter().any(|existing| existing == dir));
    SearchPath { dirs, extended }
}

fn push_unique(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if dir.as_os_str().is_empty() || dirs.iter().any(|existing| existing == &dir) {
        return;
    }
    dirs.push(dir);
}

fn fallback_bin_dirs() -> Vec<PathBuf> {
    #[cfg(not(unix))]
    {
        Vec::new()
    }
    #[cfg(unix)]
    {
        let mut dirs = Vec::new();
        #[cfg(target_os = "macos")]
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
        ]);
        #[cfg(not(target_os = "macos"))]
        dirs.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/snap/bin"),
            PathBuf::from("/var/lib/flatpak/exports/bin"),
            PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join("bin"));
        }
        dirs
    }
}

/// Reads the login shell's `PATH`. Homebrew and version managers are added in
/// `.zprofile`, which a Dock-launched app never sees.
#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL").unwrap_or_default();
    let shell = if shell.ends_with("/zsh") || shell.ends_with("/bash") {
        shell
    } else {
        "/bin/zsh".to_string()
    };
    let mut command = Command::new(shell);
    command.args(["-lc", "printf '%s\\n' \"$PATH\""]);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::null());
    command.env("TERM", "dumb");
    let mut child = command.spawn().ok()?;
    let pid = child.id();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    let output = match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(output)) => output,
        _ => {
            let _ = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            return None;
        }
    };
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .rev()
        .find(|line| line.contains('/') && !line.trim().is_empty())?;
    Some(OsString::from(line.trim()))
}

#[cfg(test)]
mod tests {
    use super::quote_shell;

    #[test]
    fn quotes_a_shell_word() {
        assert_eq!(quote_shell("/tmp/script"), "'/tmp/script'");
        assert_eq!(quote_shell("/tmp/my dir/script"), "'/tmp/my dir/script'");
        assert_eq!(
            quote_shell("/tmp/o'brien/script"),
            "'/tmp/o'\\''brien/script'"
        );
    }
}
