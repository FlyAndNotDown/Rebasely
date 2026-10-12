use super::*;

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

fn cancel_tokens() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

thread_local! {
    static CURRENT_CANCEL: RefCell<Option<(String, Arc<AtomicBool>)>> = const { RefCell::new(None) };
    static BACKGROUND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `f` with prompts turned off: no askpass dialog, no ssh passphrase
/// prompt, and no credential-manager window, so work nobody asked for fails
/// quietly instead of interrupting.
pub fn with_background<T>(background: bool, f: impl FnOnce() -> T) -> T {
    if !background {
        return f();
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            BACKGROUND.with(|flag| flag.set(false));
        }
    }
    BACKGROUND.with(|flag| flag.set(true));
    let _reset = Reset;
    f()
}

struct CancelScope {
    id: String,
}

impl Drop for CancelScope {
    fn drop(&mut self) {
        CURRENT_CANCEL.with(|current| *current.borrow_mut() = None);
        cancel_tokens()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(&self.id);
    }
}

/// Runs `f` so that `cancel_activity(activity_id)` stops the git process it is
/// waiting on. Without an id the work cannot be cancelled.
pub fn with_cancel<T>(activity_id: Option<&str>, f: impl FnOnce() -> T) -> T {
    let Some(id) = activity_id.filter(|id| !id.is_empty()) else {
        return f();
    };
    let token = Arc::new(AtomicBool::new(false));
    cancel_tokens()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(id.to_string(), token.clone());
    CURRENT_CANCEL.with(|current| *current.borrow_mut() = Some((id.to_string(), token)));
    let _scope = CancelScope { id: id.to_string() };
    f()
}

pub fn cancel_activity(id: &str) -> bool {
    let tokens = cancel_tokens()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    match tokens.get(id) {
        Some(token) => {
            token.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

fn current_cancel() -> Option<(String, Arc<AtomicBool>)> {
    CURRENT_CANCEL.with(|current| current.borrow().clone())
}

/// `cmd\git.exe` on Windows is a launcher, so killing it alone would leave the
/// real git and its remote helpers running with our pipes open.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let killed = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .is_ok_and(|status| status.success());
        if killed {
            return;
        }
    }
    let _ = child.kill();
}

/// A killed git cannot release its lock files, and every later command would
/// then fail on them. Only locks created after `since` are removed.
fn git_path(root: &Path, flag: &str) -> Option<PathBuf> {
    let absolute = ["rev-parse", "--path-format=absolute", flag];
    let plain = ["rev-parse", flag];
    for args in [absolute.as_slice(), plain.as_slice()] {
        let Ok(output) = run_git(root, args) else {
            return None;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            continue;
        }
        let path = PathBuf::from(&text);
        return Some(if path.is_absolute() {
            path
        } else {
            root.join(path)
        });
    }
    None
}

fn remove_stale_locks(root: &Path, since: SystemTime) {
    let Some(git_dir) = git_path(root, "--git-dir") else {
        return;
    };
    let common = git_path(root, "--git-common-dir").unwrap_or_else(|| git_dir.clone());
    let mut candidates = vec![
        git_dir.join("index.lock"),
        git_dir.join("HEAD.lock"),
        git_dir.join("ORIG_HEAD.lock"),
        common.join("packed-refs.lock"),
        common.join("config.lock"),
        common.join("shallow.lock"),
    ];
    let mut dirs = vec![common.join("refs")];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|ext| ext == "lock") {
                candidates.push(path);
            }
        }
    }
    for lock in candidates {
        let fresh = fs::metadata(&lock)
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified >= since);
        if fresh {
            let _ = fs::remove_file(&lock);
        }
    }
}

pub(super) fn run_git(root: &Path, args: &[&str]) -> AppResult<std::process::Output> {
    run_git_env(root, args, &[])
}

pub(super) fn run_git_env(
    root: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> AppResult<std::process::Output> {
    let git = require_git()?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|err| AppError::msg(err.to_string()))
}

/// Runs git with `input` on stdin and returns the raw output, including a
/// non-zero status. `git check-ignore` uses exit code 1 when nothing matches.
pub(super) fn run_git_input_output(
    root: &Path,
    args: &[&str],
    input: &[u8],
) -> AppResult<std::process::Output> {
    let git = require_git()?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))?;
    let mut stdin = child.stdin.take();
    let input = input.to_vec();
    let writer = thread::spawn(move || {
        if let Some(pipe) = stdin.as_mut() {
            let _ = std::io::Write::write_all(pipe, &input);
        }
    });
    let output = child
        .wait_with_output()
        .map_err(|err| AppError::msg(err.to_string()))?;
    let _ = writer.join();
    Ok(output)
}

/// Runs git with `input` on stdin, so messages and path lists never hit the
/// command-line length limit or need quoting.
pub(super) fn run_git_input(root: &Path, args: &[&str], input: &[u8]) -> AppResult<Vec<u8>> {
    let output = run_git_input_output(root, args, input)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(git_output_error(output))
}

/// Runs a git command that takes pathspecs, passing them NUL-separated on
/// stdin and matching them literally.
pub(super) fn run_git_pathspecs(
    root: &Path,
    args: &[&str],
    paths: &[String],
) -> AppResult<Vec<u8>> {
    let mut argv = vec!["--literal-pathspecs"];
    argv.extend_from_slice(args);
    argv.extend_from_slice(&["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    run_git_input(root, &argv, &input)
}

pub(super) fn run_git_ok_progress(
    root: &Path,
    args: &[&str],
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    run_git_progress(Some(root), args, on_progress)
}

pub(super) fn run_git_progress(
    root: Option<&Path>,
    args: &[&str],
    mut on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    let git = require_git()?;
    let mut command = Command::new(git);
    if let Some(root) = root {
        command.arg("-C").arg(root);
    }
    command.args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let scope = current_cancel();
    if BACKGROUND.with(|flag| flag.get()) {
        command.env("SSH_ASKPASS_REQUIRE", "never");
        command.env("GCM_INTERACTIVE", "never");
    } else {
        for (key, value) in crate::askpass::git_env(scope.as_ref().map(|(id, _)| id.as_str())) {
            command.env(key, value);
        }
    }
    let cancel = scope.map(|(_, token)| token);
    let started = SystemTime::now();
    let mut child = command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel::<String>();

    let stderr_thread = stderr.map(|pipe| {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buf = Vec::new();
            while read_progress_line(&mut reader, &mut buf).unwrap_or(0) > 0 {
                let line = String::from_utf8_lossy(&buf).trim().to_string();
                if !line.is_empty() {
                    let _ = tx.send(line);
                }
            }
        })
    });
    drop(tx);

    let stdout_thread = stdout.map(|mut pipe| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    });

    let mut logs = Vec::new();
    let mut killed = false;
    loop {
        if !killed
            && cancel
                .as_ref()
                .is_some_and(|token| token.load(Ordering::Relaxed))
        {
            kill_tree(&mut child);
            killed = true;
        }
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok(line) => {
                logs.push(line.clone());
                on_progress(&line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    while let Ok(line) = rx.try_recv() {
        logs.push(line.clone());
        on_progress(&line);
    }

    let status = child.wait().map_err(|err| AppError::msg(err.to_string()))?;
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    let stdout_bytes = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if killed {
        if let Some(root) = root {
            remove_stale_locks(root, started);
        }
        return Err(AppError::cancelled());
    }
    if status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = logs
        .into_iter()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(AppError::msg(if message.is_empty() {
        "Git command failed".to_string()
    } else {
        message
    }))
}

pub(super) fn read_progress_line(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
) -> std::io::Result<usize> {
    buf.clear();
    loop {
        let consumed = {
            let available = match reader.fill_buf() {
                Ok(bytes) => bytes,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(err),
            };
            if available.is_empty() {
                return Ok(buf.len());
            }
            let mut take = 0;
            for byte in available {
                take += 1;
                if *byte == b'\n' || *byte == b'\r' {
                    break;
                }
                buf.push(*byte);
            }
            take
        };
        reader.consume(consumed);
        if buf.is_empty() {
            continue;
        }
        return Ok(buf.len());
    }
}

pub(super) fn run_git_stdout(root: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    let output = run_git(root, args)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(AppError::msg(if message.is_empty() {
        "Git command failed".to_string()
    } else {
        message
    }))
}

pub(super) fn require_git() -> AppResult<PathBuf> {
    find_git().ok_or_else(|| AppError::msg(crate::error::GIT_MISSING))
}

struct GitBin {
    /// Empty selects the `git` executable on PATH.
    selected: String,
    resolved: Option<PathBuf>,
    loaded: bool,
}

fn git_bin() -> &'static Mutex<GitBin> {
    static BIN: OnceLock<Mutex<GitBin>> = OnceLock::new();
    BIN.get_or_init(|| {
        Mutex::new(GitBin {
            selected: String::new(),
            resolved: None,
            loaded: false,
        })
    })
}

fn find_git() -> Option<PathBuf> {
    let mut bin = git_bin().lock().unwrap_or_else(|err| err.into_inner());
    if bin.resolved.as_ref().is_some_and(|path| path.is_file()) {
        return bin.resolved.clone();
    }
    let resolved = resolve_git(&bin.selected);
    bin.resolved = resolved.clone();
    bin.loaded = true;
    resolved
}

/// `selected` is empty to use PATH, or the full path of a chosen executable.
/// A missing chosen file does not fall back to PATH.
pub fn set_git_executable(selected: &str) {
    let mut selected = selected.trim().to_string();
    if !selected.is_empty() && !is_git_executable_name(Path::new(&selected)) {
        selected.clear();
    }
    let mut bin = git_bin().lock().unwrap_or_else(|err| err.into_inner());
    if bin.loaded
        && bin.selected == selected
        && bin.resolved.as_ref().is_some_and(|path| path.is_file())
    {
        return;
    }
    let resolved = resolve_git(&selected);
    *bin = GitBin {
        selected,
        resolved,
        loaded: true,
    };
}

fn resolve_git(selected: &str) -> Option<PathBuf> {
    if selected.is_empty() {
        return which("git");
    }
    let path = PathBuf::from(selected);
    if is_git_executable_name(&path) && path.is_file() {
        Some(path)
    } else {
        None
    }
}

pub fn git_on_path() -> Option<String> {
    which("git").map(|path| path.to_string_lossy().into_owned())
}

pub fn active_git() -> Option<String> {
    find_git().map(|path| path.to_string_lossy().into_owned())
}

/// The file name's stem must be `git`, so `git`, `git.exe`, and `git.cmd` pass.
fn is_git_executable_name(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("git"))
}

fn same_git_path(left: &str, right: &str) -> bool {
    fold_git_path(left) == fold_git_path(right)
}

fn fold_git_path(path: &str) -> String {
    let slash = path.trim().replace('\\', "/");
    let trimmed = slash.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

pub fn validate_git_choice(path: &str) -> AppResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(());
    }
    let file = Path::new(path);
    if !is_git_executable_name(file) {
        return Err(AppError::msg("Choose a file named git."));
    }
    if !file.is_file() {
        return Err(AppError::msg(crate::error::GIT_MISSING));
    }
    Ok(())
}

pub fn normalize_extra_git_paths(paths: Vec<String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for raw in paths {
        let path = raw.trim();
        if path.is_empty() || !is_git_executable_name(Path::new(path)) {
            continue;
        }
        if kept.iter().any(|existing| same_git_path(existing, path)) {
            continue;
        }
        kept.push(path.to_string());
    }
    kept
}

/// Drops a custom path that is the PATH executable, and keeps the chosen file
/// in the added list so Settings can show it.
pub fn prepare_git_prefs(git_path: &str, extras: Vec<String>) -> AppResult<(String, Vec<String>)> {
    let mut git_path = git_path.trim().to_string();
    let on_path = git_on_path();
    if !git_path.is_empty() {
        if let Some(found) = &on_path {
            if same_git_path(&git_path, found) {
                git_path.clear();
            }
        }
    }
    validate_git_choice(&git_path)?;
    let mut extras = normalize_extra_git_paths(extras);
    if let Some(found) = &on_path {
        extras.retain(|path| !same_git_path(path, found));
    }
    if !git_path.is_empty() && !extras.iter().any(|path| same_git_path(path, &git_path)) {
        extras.insert(0, git_path.clone());
    }
    Ok((git_path, extras))
}

pub fn check_git_executable(path: &str) -> AppResult<()> {
    validate_git_choice(path)?;
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg(crate::error::GIT_MISSING));
    }
    let output = git_version_output(path)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}").to_ascii_lowercase();
    if output.status.success() && combined.contains("git version") {
        Ok(())
    } else {
        Err(AppError::msg("That file is not a Git executable."))
    }
}

fn git_version_output(path: &str) -> AppResult<std::process::Output> {
    let mut command = Command::new(path);
    command.arg("--version");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|_| AppError::msg("That file is not a Git executable."))?;
    let pid = child.id();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(output)) => Ok(output),
        _ => {
            kill_pid(pid);
            Err(AppError::msg("That file is not a Git executable."))
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

pub(super) fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let mut names = vec![name.to_string()];
    if let Ok(pathext) = std::env::var("PATHEXT") {
        for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
            names.push(format!("{name}{ext}"));
        }
    }
    for dir in std::env::split_paths(&paths) {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if candidate.is_file() {
                return Some(on_disk_name(candidate));
            }
        }
    }
    None
}

/// Windows treats `git.EXE` and `git.exe` as the same file, and `PATHEXT` is
/// uppercase, so the probe path is not the name stored on disk.
fn on_disk_name(candidate: PathBuf) -> PathBuf {
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

pub(super) fn spawn_git_stdout(root: &Path, args: &[&str]) -> AppResult<std::process::Child> {
    let git = require_git()?;
    let mut command = Command::new(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| AppError::msg(err.to_string()))
}

pub(super) fn read_git_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> AppResult<bool> {
    buf.clear();
    let read = reader
        .read_until(b'\n', buf)
        .map_err(|err| AppError::msg(err.to_string()))?;
    if read == 0 {
        return Ok(false);
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    if buf.is_empty() {
        return read_git_line(reader, buf);
    }
    Ok(true)
}

pub(super) fn git_output_error(output: std::process::Output) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    AppError::msg(if message.is_empty() {
        "Git command failed".to_string()
    } else {
        message
    })
}

#[cfg(test)]
mod git_executable_tests {
    use super::{
        is_git_executable_name, normalize_extra_git_paths, same_git_path, validate_git_choice,
    };
    use std::path::Path;

    #[test]
    fn accepts_only_a_file_named_git() {
        assert!(is_git_executable_name(Path::new("git")));
        assert!(is_git_executable_name(Path::new("git.exe")));
        assert!(is_git_executable_name(Path::new("GIT.EXE")));
        assert!(is_git_executable_name(Path::new("git.cmd")));
        assert!(is_git_executable_name(Path::new("/usr/bin/git")));
        assert!(is_git_executable_name(Path::new(
            r"C:\Program Files\Git\cmd\git.exe"
        )));
        assert!(!is_git_executable_name(Path::new("git-lfs.exe")));
        assert!(!is_git_executable_name(Path::new("gitk.exe")));
        assert!(!is_git_executable_name(Path::new("git.exe.bak")));
    }

    #[test]
    fn rejects_a_missing_or_misnamed_choice() {
        assert!(validate_git_choice("").is_ok());
        assert!(validate_git_choice("   ").is_ok());
        assert_eq!(
            validate_git_choice("gitk.exe").unwrap_err().to_string(),
            "Choose a file named git."
        );
        assert_eq!(
            validate_git_choice("rebasely-no-such-dir/git.exe")
                .unwrap_err()
                .to_string(),
            crate::error::GIT_MISSING
        );
    }

    #[test]
    fn keeps_distinct_git_executables() {
        let paths = normalize_extra_git_paths(vec![
            r"C:\Git\cmd\git.exe".into(),
            "C:/Git/cmd/git.exe".into(),
            "git-lfs.exe".into(),
            "/usr/bin/git".into(),
            "  ".into(),
        ]);
        assert_eq!(
            paths,
            vec![
                r"C:\Git\cmd\git.exe".to_string(),
                "/usr/bin/git".to_string()
            ]
        );
    }

    #[test]
    fn folds_path_case_on_windows() {
        assert_eq!(
            same_git_path(r"C:\Git\cmd\git.exe", "c:/git/cmd/git.exe"),
            cfg!(windows)
        );
    }

    #[cfg(windows)]
    #[test]
    fn keeps_the_on_disk_extension_case() {
        let dir = std::env::temp_dir().join(format!("rebasely-git-case-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("git.exe");
        std::fs::write(&real, b"").unwrap();
        let found = super::on_disk_name(dir.join("git.EXE"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            found.file_name().and_then(|name| name.to_str()),
            Some("git.exe")
        );
    }

    #[test]
    fn checks_the_git_on_path() {
        let Some(path) = super::git_on_path() else {
            return;
        };
        assert!(super::check_git_executable(&path).is_ok());
    }

    #[test]
    fn rejects_a_file_that_is_not_git() {
        let dir = std::env::temp_dir().join(format!("rebasely-not-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(if cfg!(windows) { "git.exe" } else { "git" });
        std::fs::write(&path, b"not a git executable").unwrap();
        let text = path.to_string_lossy().into_owned();
        let message = super::check_git_executable(&text).unwrap_err().to_string();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(message, "That file is not a Git executable.");
    }
}
