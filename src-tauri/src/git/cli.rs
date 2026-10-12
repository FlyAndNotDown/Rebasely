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
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
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
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
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
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
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

pub(super) fn find_git() -> Option<PathBuf> {
    static GIT: OnceLock<PathBuf> = OnceLock::new();
    if let Some(path) = GIT.get() {
        return Some(path.clone());
    }
    let found = locate_git()?;
    Some(GIT.get_or_init(|| found).clone())
}

pub(super) fn locate_git() -> Option<PathBuf> {
    if let Some(path) = which("git") {
        return Some(path);
    }
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\Git\cmd\git.exe",
        r"C:\Program Files\Git\bin\git.exe",
        r"C:\Program Files (x86)\Git\cmd\git.exe",
        "/usr/bin/git",
        "/usr/local/bin/git",
        "/opt/homebrew/bin/git",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
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
                return Some(candidate);
            }
        }
    }
    None
}

pub(super) fn spawn_git_stdout(root: &Path, args: &[&str]) -> AppResult<std::process::Child> {
    let git = find_git().ok_or_else(|| AppError::msg("Git executable was not found"))?;
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
