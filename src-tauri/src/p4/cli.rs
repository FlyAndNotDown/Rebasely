//! Runs the `p4` executable the same way a terminal would.
//!
//! Flags on the command line carry the workspace (`-p`, `-u`, `-c`), so an
//! inherited `P4CONFIG` cannot silently switch servers mid-command.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crate::error::{AppError, AppResult, P4_LOGIN, P4_MISSING};

struct P4Bin {
    selected: String,
    resolved: Option<PathBuf>,
    loaded: bool,
}

fn p4_bin() -> &'static Mutex<P4Bin> {
    static BIN: OnceLock<Mutex<P4Bin>> = OnceLock::new();
    BIN.get_or_init(|| {
        Mutex::new(P4Bin {
            selected: String::new(),
            resolved: None,
            loaded: false,
        })
    })
}

pub fn set_p4_executable(selected: &str) {
    let mut selected = selected.trim().to_string();
    if !selected.is_empty() && !is_p4_executable_name(Path::new(&selected)) {
        selected.clear();
    }
    let mut bin = p4_bin().lock().unwrap_or_else(|err| err.into_inner());
    if bin.loaded
        && bin.selected == selected
        && bin.resolved.as_ref().is_some_and(|path| path.is_file())
    {
        return;
    }
    let resolved = resolve_p4(&selected);
    *bin = P4Bin {
        selected,
        resolved,
        loaded: true,
    };
}

fn resolve_p4(selected: &str) -> Option<PathBuf> {
    if selected.is_empty() {
        return crate::locate::which("p4");
    }
    let path = PathBuf::from(selected);
    if is_p4_executable_name(&path) && path.is_file() {
        Some(path)
    } else {
        None
    }
}

fn find_p4() -> Option<PathBuf> {
    let mut bin = p4_bin().lock().unwrap_or_else(|err| err.into_inner());
    if bin.resolved.as_ref().is_some_and(|path| path.is_file()) {
        return bin.resolved.clone();
    }
    let resolved = resolve_p4(&bin.selected);
    bin.resolved = resolved.clone();
    bin.loaded = true;
    resolved
}

pub fn p4_on_path() -> Option<String> {
    crate::locate::which("p4").map(|path| path.to_string_lossy().into_owned())
}

pub fn active_p4() -> Option<String> {
    find_p4().map(|path| path.to_string_lossy().into_owned())
}

pub fn require_p4() -> AppResult<PathBuf> {
    find_p4().ok_or_else(|| AppError::msg(P4_MISSING))
}

fn is_p4_executable_name(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("p4"))
}

fn same_p4_path(left: &str, right: &str) -> bool {
    fold_p4_path(left) == fold_p4_path(right)
}

fn fold_p4_path(path: &str) -> String {
    let slash = path.trim().replace('\\', "/");
    let trimmed = slash.trim_end_matches('/');
    if cfg!(any(windows, target_os = "macos")) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

pub fn validate_p4_choice(path: &str) -> AppResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(());
    }
    let file = Path::new(path);
    if !is_p4_executable_name(file) {
        return Err(AppError::msg("Choose a file named p4."));
    }
    if !file.is_file() {
        return Err(AppError::msg(P4_MISSING));
    }
    Ok(())
}

pub fn normalize_extra_p4_paths(paths: Vec<String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for raw in paths {
        let path = raw.trim();
        if path.is_empty() || !is_p4_executable_name(Path::new(path)) {
            continue;
        }
        if kept.iter().any(|existing| same_p4_path(existing, path)) {
            continue;
        }
        kept.push(path.to_string());
    }
    kept
}

pub fn prepare_p4_prefs(p4_path: &str, extras: Vec<String>) -> AppResult<(String, Vec<String>)> {
    let mut p4_path = p4_path.trim().to_string();
    let on_path = p4_on_path();
    if !p4_path.is_empty() {
        if let Some(found) = &on_path {
            if same_p4_path(&p4_path, found) {
                p4_path.clear();
            }
        }
    }
    validate_p4_choice(&p4_path)?;
    let mut extras = normalize_extra_p4_paths(extras);
    if let Some(found) = &on_path {
        extras.retain(|path| !same_p4_path(path, found));
    }
    if !p4_path.is_empty() && !extras.iter().any(|path| same_p4_path(path, &p4_path)) {
        extras.insert(0, p4_path.clone());
    }
    Ok((p4_path, extras))
}

pub fn check_p4_executable(path: &str) -> AppResult<()> {
    validate_p4_choice(path)?;
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg(P4_MISSING));
    }
    let output = p4_version_output(path)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}").to_ascii_lowercase();
    if output.status.success() && (combined.contains("perforce") || combined.contains("rev. p4")) {
        Ok(())
    } else {
        Err(AppError::msg("That file is not a p4 executable."))
    }
}

fn p4_version_output(path: &str) -> AppResult<std::process::Output> {
    let mut command = p4_command(path);
    command.arg("-V");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|_| AppError::msg("That file is not a p4 executable."))?;
    let pid = child.id();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(output)) => Ok(output),
        _ => {
            kill_pid(pid);
            Err(AppError::msg("That file is not a p4 executable."))
        }
    }
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn p4_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = crate::locate::command(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[derive(Clone)]
pub struct P4Env {
    pub cwd: PathBuf,
    pub port: String,
    pub user: String,
    pub client: String,
    pub charset: String,
}

pub fn run_p4(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<std::process::Output> {
    let output = run_once(env, args, input)?;
    let message = output_message(&output);
    if !output.status.success() && needs_trust(&message) {
        trust(env)?;
        return run_once(env, args, input);
    }
    Ok(output)
}

pub fn run_p4_ok(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<String> {
    finish(run_p4(env, args, input)?)
}

/// `p4 diff` can exit non-zero when the files differ. A diff body is still a result.
pub fn run_p4_diff(env: &P4Env, args: &[&str]) -> AppResult<String> {
    let output = run_p4(env, args, None)?;
    let message = output_message(&output);
    if needs_login(&message) {
        return Err(AppError::msg(P4_LOGIN));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() || looks_like_diff(&stdout) {
        return Ok(stdout);
    }
    Err(AppError::msg(if message.is_empty() {
        "p4 command failed".to_string()
    } else {
        message
    }))
}

pub fn run_p4_stream(
    env: &P4Env,
    args: &[&str],
    mut on_line: impl FnMut(String),
) -> AppResult<String> {
    let (ok, stdout, stderr) = stream_once(env, args, &mut on_line)?;
    let message = combine(&stderr, &stdout);
    if !ok && needs_trust(&message) {
        trust(env)?;
        let (ok, stdout, stderr) = stream_once(env, args, &mut on_line)?;
        return finish_parts(ok, stdout, stderr);
    }
    finish_parts(ok, stdout, stderr)
}

fn finish(output: std::process::Output) -> AppResult<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    finish_parts(output.status.success(), stdout, stderr)
}

fn finish_parts(ok: bool, stdout: String, stderr: String) -> AppResult<String> {
    let message = combine(&stderr, &stdout);
    if needs_login(&message) {
        return Err(AppError::msg(P4_LOGIN));
    }
    if !ok {
        return Err(AppError::msg(if message.is_empty() {
            "p4 command failed".to_string()
        } else {
            message
        }));
    }
    Ok(stdout)
}

fn run_once(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<std::process::Output> {
    let program = require_p4()?;
    let mut command = prepared(program, env, args);
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))?;
    if let Some(text) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|err| AppError::msg(err.to_string()))?;
        }
    }
    child
        .wait_with_output()
        .map_err(|err| AppError::msg(err.to_string()))
}

fn stream_once(
    env: &P4Env,
    args: &[&str],
    on_line: &mut dyn FnMut(String),
) -> AppResult<(bool, String, String)> {
    let program = require_p4()?;
    let mut command = prepared(program, env, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))?;
    let stderr = child.stderr.take();
    let stderr_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let mut stdout_text = String::new();
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            let read = reader
                .read_until(b'\n', &mut buf)
                .map_err(|err| AppError::msg(err.to_string()))?;
            if read == 0 {
                break;
            }
            while matches!(buf.last(), Some(b'\n' | b'\r')) {
                buf.pop();
            }
            let line = String::from_utf8_lossy(&buf).into_owned();
            if line.is_empty() {
                continue;
            }
            stdout_text.push_str(&line);
            stdout_text.push('\n');
            on_line(line);
        }
    }
    let status = child.wait().map_err(|err| AppError::msg(err.to_string()))?;
    let stderr_bytes = stderr_thread.join().unwrap_or_default();
    let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
    Ok((status.success(), stdout_text, stderr_text))
}

fn prepared(program: PathBuf, env: &P4Env, args: &[&str]) -> Command {
    let mut command = p4_command(program);
    if env.cwd.as_os_str().is_empty() {
        // Detection can run before a client root exists.
    } else if env.cwd.is_dir() {
        command.current_dir(&env.cwd);
    }
    if !env.port.is_empty() {
        command.arg("-p").arg(&env.port);
    }
    if !env.user.is_empty() {
        command.arg("-u").arg(&env.user);
    }
    if !env.client.is_empty() {
        command.arg("-c").arg(&env.client);
    }
    if !env.charset.is_empty() {
        command.arg("-C").arg(&env.charset);
    }
    command.args(args);
    command.env_remove("P4CONFIG");
    command.env_remove("P4PASSWD");
    command
}

fn trust(env: &P4Env) -> AppResult<()> {
    let mut bare = env.clone();
    bare.client.clear();
    let output = run_once(&bare, &["trust", "-y"], None)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::msg(output_message(&output)))
    }
}

pub fn login(env: &P4Env, password: &str) -> AppResult<()> {
    if password.is_empty() {
        return Err(AppError::msg("Password is required."));
    }
    let mut bare = env.clone();
    bare.client.clear();
    let output = run_p4(&bare, &["login"], Some(&format!("{password}\n")))?;
    if output.status.success() {
        return Ok(());
    }
    let message = output_message(&output);
    let lower = message.to_ascii_lowercase();
    if lower.contains("password") || needs_login(&message) {
        return Err(AppError::msg("Perforce rejected that password."));
    }
    Err(AppError::msg(if message.is_empty() {
        "p4 login failed".to_string()
    } else {
        message
    }))
}

fn output_message(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    combine(&stderr, &stdout)
}

fn combine(stderr: &str, stdout: &str) -> String {
    [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn needs_trust(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("p4 trust") || lower.contains("authenticity of")
}

fn needs_login(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("please login")
        || lower.contains("session has expired")
        || lower.contains("ticket expired")
        || (lower.contains("password")
            && (lower.contains("invalid") || lower.contains("unset") || lower.contains("expired")))
}

fn looks_like_diff(text: &str) -> bool {
    text.lines().any(|line| {
        line.starts_with("@@")
            || line.starts_with("==== ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
    })
}

#[cfg(test)]
mod tests {
    use super::{is_p4_executable_name, normalize_extra_p4_paths, validate_p4_choice};
    use std::path::Path;

    #[test]
    fn accepts_only_a_file_named_p4() {
        assert!(is_p4_executable_name(Path::new("p4")));
        assert!(is_p4_executable_name(Path::new("p4.exe")));
        assert!(is_p4_executable_name(Path::new("P4.CMD")));
        assert!(!is_p4_executable_name(Path::new("p4v.exe")));
        assert!(!is_p4_executable_name(Path::new("p4d.exe")));
        assert!(validate_p4_choice("").is_ok());
        assert!(validate_p4_choice("p4v.exe").is_err());
    }

    #[test]
    fn extra_paths_drop_duplicates_and_other_tools() {
        let extras = normalize_extra_p4_paths(vec![
            r"C:\Perforce\p4.exe".into(),
            r"C:/Perforce/p4.exe".into(),
            r"C:\Perforce\p4v.exe".into(),
        ]);
        assert_eq!(extras, vec![r"C:\Perforce\p4.exe".to_string()]);
    }
}
