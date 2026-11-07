use super::*;

use crate::diagnostics::{self, Code, CommandOutput, Status};
use crate::error::GIT_BACKGROUND_TIMEOUT as BACKGROUND_TIMEOUT;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime};

const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAX_PROGRESS_LINES: usize = 8;

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
/// real git and its remote helpers running with our pipes open. On Unix the
/// same is true of `ssh` and `git-remote-https`, so the child is started in
/// its own process group and the whole group is killed.
fn kill_tree(child: &mut std::process::Child) {
    if crate::platform::kill_process_tree(child.id()) {
        return;
    }
    let _ = child.kill();
}

pub(super) fn stop_child(child: &mut std::process::Child) {
    kill_tree(child);
    let _ = child.wait();
}

pub(super) fn git_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    crate::platform::background_command(program)
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

fn diagnostic_command<'a, 'b>(
    mut args: &'a [&'b str],
    background: bool,
) -> Option<(Code, &'a [&'b str])> {
    while let Some((arg, rest)) = args.split_first() {
        match *arg {
            "-c" | "-C" => args = rest.get(1..)?,
            "--no-optional-locks" | "--literal-pathspecs" | "--no-pager" => args = rest,
            verb => {
                let code = match verb {
                    "status" => Code::GitStatus,
                    "diff" => Code::GitDiff,
                    "log" | "show" => Code::GitHistory,
                    "fetch" if background => Code::GitBackgroundFetch,
                    "fetch" => Code::GitFetch,
                    "pull" => Code::GitPull,
                    "push" => Code::GitPush,
                    "clone" => Code::GitClone,
                    "commit" => Code::GitCommit,
                    "add" | "rm" | "apply" => Code::GitStage,
                    "branch" | "tag" if rest.contains(&"--") => Code::GitWorkspace,
                    "remote" if matches!(rest.first(), Some(&"add" | &"set-url" | &"remove")) => {
                        Code::GitWorkspace
                    }
                    "worktree" if matches!(rest.first(), Some(&"add" | &"remove" | &"prune")) => {
                        Code::GitWorkspace
                    }
                    "checkout" | "switch" | "restore" | "reset" | "clean" | "merge" | "rebase"
                    | "revert" | "cherry-pick" | "mv" | "submodule" | "update-ref" => {
                        Code::GitWorkspace
                    }
                    "stash" if !matches!(rest.first(), Some(&"list" | &"show")) => Code::GitStash,
                    _ => return None,
                };
                return Some((code, args));
            }
        }
    }
    None
}

fn record_output(args: &[&str], started: Instant, output: &AppResult<std::process::Output>) {
    if let Some((code, args)) = diagnostic_command(args, BACKGROUND.with(|flag| flag.get())) {
        diagnostics::record_cli_output(code, args, started, output, |output| {
            output.status.success()
                || (code == Code::GitDiff
                    && args
                        .iter()
                        .any(|arg| matches!(*arg, "--no-index" | "--exit-code" | "--quiet"))
                    && output.status.code() == Some(1))
        });
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
    let started = Instant::now();
    let output = require_git().and_then(|git| {
        let mut command = git_command(git);
        command.arg("-C").arg(root).args(args);
        command.env("GIT_TERMINAL_PROMPT", "0");
        for (key, value) in env {
            command.env(key, value);
        }
        command
            .output()
            .map_err(|err| git_start_error(command.get_program(), err))
    });
    record_output(args, started, &output);
    output
}

/// Runs git with `input` on stdin and returns the raw output, including a
/// non-zero status. `git check-ignore` uses exit code 1 when nothing matches.
pub(super) fn run_git_input_output(
    root: &Path,
    args: &[&str],
    input: &[u8],
) -> AppResult<std::process::Output> {
    let started = Instant::now();
    let output = git_input_output(root, args, input);
    record_output(args, started, &output);
    output
}

fn git_input_output(root: &Path, args: &[&str], input: &[u8]) -> AppResult<std::process::Output> {
    let git = require_git()?;
    let mut command = git_command(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| git_start_error(command.get_program(), err))?;
    let mut stdin = child.stdin.take();
    let input = input.to_vec();
    let writer = thread::spawn(move || {
        if let Some(pipe) = stdin.as_mut() {
            let _ = std::io::Write::write_all(pipe, &input);
        }
    });
    let output = child
        .wait_with_output()
        .map_err(|err| AppError::msg(err.to_string()));
    if output.is_ok() {
        let _ = writer.join();
    }
    output
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
    let timer = Instant::now();
    let git = match require_git() {
        Ok(git) => git,
        Err(error) => {
            let failed = Err(error);
            record_output(args, timer, &failed);
            return failed.map(|_| ());
        }
    };
    let mut command = git_command(git);
    if let Some(root) = root {
        command.arg("-C").arg(root);
    }
    command.args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let scope = current_cancel();
    if BACKGROUND.with(|flag| flag.get()) {
        command.env("GIT_ASKPASS", "");
        command.env("SSH_ASKPASS", "");
        command.env("SSH_ASKPASS_REQUIRE", "never");
        command.env("GCM_INTERACTIVE", "never");
    } else {
        for (key, value) in crate::askpass::git_env(scope.as_ref().map(|(id, _)| id.as_str())) {
            command.env(key, value);
        }
    }
    let started = SystemTime::now();
    let background = BACKGROUND.with(|flag| flag.get());
    let diagnostic = diagnostic_command(args, background);
    let mut capture = ProgressCapture::default();
    let result = run_progress_command(
        &mut command,
        scope.map(|(_, token)| token),
        background.then_some(ProgressLimits::BACKGROUND),
        &mut on_progress,
        diagnostic.map(|_| &mut capture),
    );
    if let Some((code, args)) = diagnostic {
        diagnostics::record_cli(
            code,
            args,
            timer,
            Status::of(&result),
            CommandOutput {
                status: capture.status,
                stdout: &capture.stdout,
                stderr: capture.stderr.as_bytes(),
            },
            result.as_ref().err().filter(|_| {
                capture.status.is_none_or(|status| status.success()) || capture.stopped
            }),
        );
    }
    if !background && result.as_ref().is_err_and(|error| error.is_cancelled()) {
        if let Some(root) = root {
            remove_stale_locks(root, started);
        }
    }
    result
}

#[derive(Clone, Copy)]
struct ProgressLimits {
    idle: Duration,
    total: Duration,
}

impl ProgressLimits {
    const BACKGROUND: Self = Self {
        idle: Duration::from_secs(120),
        total: Duration::from_secs(15 * 60),
    };
}

const PROGRESS_POLL: Duration = Duration::from_millis(30);
const STOP_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

struct ProgressProcess {
    child: std::process::Child,
    tree: Option<crate::platform::ProbeProcessTreeGuard>,
    reaped: bool,
}

impl ProgressProcess {
    fn terminate(&mut self) {
        if !self
            .tree
            .as_ref()
            .is_some_and(|tree| tree.terminate(self.child.id()))
        {
            kill_tree(&mut self.child);
        }
        let _ = self.child.kill();
    }

    fn reap_later(mut self) {
        self.terminate();
        // Retain the child handle and owned tree even if the OS cannot reap a
        // terminated process promptly. The unattended request can still end.
        thread::spawn(move || self.finish_reaping());
    }

    fn finish_reaping(mut self) {
        let _ = self.child.wait();
        self.reaped = true;
    }
}

impl Drop for ProgressProcess {
    fn drop(&mut self) {
        if !self.reaped {
            self.terminate();
            let _ = self.child.wait();
        }
    }
}

struct ProgressReader<R> {
    pipe: R,
    activity: Arc<AtomicU64>,
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let read = self.pipe.read(bytes)?;
        if read > 0 {
            self.activity.fetch_add(read as u64, Ordering::Relaxed);
        }
        Ok(read)
    }
}

enum ProgressEvent {
    Line(String),
    StderrDone,
    StdoutDone(Vec<u8>),
}

#[derive(Clone, Copy)]
enum ProgressStop {
    Cancelled,
    TimedOut,
}

#[derive(Default)]
struct ProgressCapture {
    status: Option<std::process::ExitStatus>,
    stopped: bool,
    stdout: Vec<u8>,
    stderr: String,
}

fn run_progress_command(
    command: &mut Command,
    cancel: Option<Arc<AtomicBool>>,
    limits: Option<ProgressLimits>,
    on_progress: &mut (impl FnMut(&str) + Send),
    capture: Option<&mut ProgressCapture>,
) -> AppResult<()> {
    let (child, tree) = if limits.is_some() {
        let (child, tree) = crate::platform::spawn_probe_command(command)
            .map_err(|err| git_start_error(command.get_program(), err))?;
        (child, Some(tree))
    } else {
        let child = command
            .spawn()
            .map_err(|err| git_start_error(command.get_program(), err))?;
        (child, None)
    };
    let mut process = ProgressProcess {
        child,
        tree,
        reaped: false,
    };
    let started = Instant::now();
    let activity = Arc::new(AtomicU64::new(0));
    let stdout = process.child.stdout.take();
    let stderr = process.child.stderr.take();
    let mut stdout_done = stdout.is_none();
    let mut stderr_done = stderr.is_none();
    let (tx, rx) = mpsc::sync_channel::<ProgressEvent>(64);

    let stderr_thread = stderr.map(|pipe| {
        let tx = tx.clone();
        let activity = activity.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(ProgressReader { pipe, activity });
            let mut buf = Vec::new();
            while read_progress_line(&mut reader, &mut buf).unwrap_or(0) > 0 {
                let line = String::from_utf8_lossy(&buf);
                if !line.trim().is_empty()
                    && tx.send(ProgressEvent::Line(line.into_owned())).is_err()
                {
                    return;
                }
            }
            let _ = tx.send(ProgressEvent::StderrDone);
        })
    });
    let stdout_thread = stdout.map(|pipe| {
        let tx = tx.clone();
        let activity = activity.clone();
        thread::spawn(move || {
            let bytes = diagnostic_tail(&mut ProgressReader { pipe, activity }).unwrap_or_default();
            let _ = tx.send(ProgressEvent::StdoutDone(bytes));
        })
    });
    drop(tx);

    let mut logs = VecDeque::new();
    let mut stdout_bytes = Vec::new();
    let mut seen_activity = 0;
    let mut last_activity = started;
    let mut stopped = None;
    let mut stopped_at = None;
    let status = loop {
        let now = Instant::now();
        let bytes = activity.load(Ordering::Relaxed);
        if bytes != seen_activity {
            seen_activity = bytes;
            last_activity = now;
        }
        if stopped.is_none() {
            let reason = if cancel
                .as_ref()
                .is_some_and(|token| token.load(Ordering::Relaxed))
            {
                Some(ProgressStop::Cancelled)
            } else if limits.is_some_and(|limits| {
                now.duration_since(started) >= limits.total
                    || now.duration_since(last_activity) >= limits.idle
            }) {
                Some(ProgressStop::TimedOut)
            } else {
                None
            };
            if let Some(reason) = reason {
                process.terminate();
                stopped = Some(reason);
                stopped_at = Some(now);
            }
        }
        // Keep the launcher unreaped while helpers can still own its pipes.
        // The owned process tree can then stop them without a recycled PID.
        if stdout_done && stderr_done {
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    process.reaped = true;
                    break Some(status);
                }
                Ok(None) => {}
                Err(error) => {
                    if limits.is_some() {
                        process.reap_later();
                    }
                    return Err(AppError::msg(error.to_string()));
                }
            }
        }
        if stopped_at.is_some_and(|since| now.duration_since(since) >= STOP_DRAIN_TIMEOUT) {
            break None;
        }
        match rx.recv_timeout(PROGRESS_POLL) {
            Ok(ProgressEvent::Line(line)) => {
                remember_progress(&mut logs, &line);
                on_progress(&crate::error::redact_credentials(line.trim()));
            }
            Ok(ProgressEvent::StderrDone) => stderr_done = true,
            Ok(ProgressEvent::StdoutDone(bytes)) => {
                stdout_bytes = bytes;
                stdout_done = true;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // Both readers can close their pipes before Git itself exits.
            Err(mpsc::RecvTimeoutError::Disconnected) => thread::sleep(PROGRESS_POLL),
        }
    };
    // Join only after readers report EOF. A broken or escaped helper must not
    // turn a bounded stop back into an unbounded wait for an inherited pipe.
    if stderr_done {
        if let Some(handle) = stderr_thread {
            let _ = handle.join();
        }
    }
    if stdout_done {
        if let Some(handle) = stdout_thread {
            let _ = handle.join();
        }
    }
    if let Some(capture) = capture {
        capture.status = status;
        capture.stopped = stopped.is_some();
        capture.stdout.clone_from(&stdout_bytes);
        let mut bytes = 0;
        let count = logs
            .iter()
            .rev()
            .take_while(|line| {
                bytes += line.len() + 1;
                bytes <= 2048
            })
            .count();
        if count == 0 && !logs.is_empty() {
            capture
                .stderr
                .push_str("[output omitted: progress line exceeds 2048 bytes]");
        }
        for line in logs.iter().skip(logs.len() - count) {
            capture.stderr.push_str(line);
            capture.stderr.push('\n');
        }
    }
    if let Some(reason) = stopped {
        if limits.is_some() && !process.reaped {
            process.reap_later();
        }
        return Err(match reason {
            ProgressStop::Cancelled => AppError::cancelled(),
            ProgressStop::TimedOut => AppError::msg(BACKGROUND_TIMEOUT),
        });
    }
    if let Some(tree) = process.tree.as_ref() {
        tree.disarm().map_err(|error| {
            AppError::msg(format!("Could not release Git process helpers: {error}"))
        })?;
    }
    if status.is_some_and(|status| status.success()) {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = logs
        .iter()
        .map(|line| line.trim())
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

fn remember_progress(logs: &mut VecDeque<String>, line: &str) {
    if logs.len() == MAX_PROGRESS_LINES {
        logs.pop_front();
    }
    logs.push_back(line.to_string());
}

fn diagnostic_tail(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut tail = VecDeque::with_capacity(MAX_DIAGNOSTIC_BYTES);
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => return Ok(tail.into_iter().collect()),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let excess = (tail.len() + read).saturating_sub(MAX_DIAGNOSTIC_BYTES);
        tail.drain(..excess);
        tail.extend(&chunk[..read]);
    }
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
                if buf.len() < MAX_DIAGNOSTIC_BYTES {
                    buf.push(*byte);
                }
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
    if bin
        .resolved
        .as_ref()
        .is_some_and(|path| crate::locate::is_executable(path))
    {
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
        && bin
            .resolved
            .as_ref()
            .is_some_and(|path| crate::locate::is_executable(path))
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
    if is_git_executable_name(&path) && crate::locate::is_executable(&path) {
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
    let slash = if cfg!(windows) {
        path.trim().replace('\\', "/")
    } else {
        path.trim().to_string()
    };
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
    if !crate::locate::is_executable(file) {
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
    let mut command = git_command(path);
    command.arg("--version");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    crate::platform::kill_process_tree(pid);
}

pub(super) fn which(name: &str) -> Option<PathBuf> {
    crate::locate::which(name)
}

pub(super) fn spawn_git_stdout(root: &Path, args: &[&str]) -> AppResult<std::process::Child> {
    let git = require_git()?;
    let mut command = git_command(git);
    command.arg("-C").arg(root).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|err| git_start_error(command.get_program(), err))
}

fn git_start_error(program: &std::ffi::OsStr, error: std::io::Error) -> AppError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
    ) && !crate::locate::is_executable(Path::new(program))
    {
        AppError::msg(crate::error::GIT_MISSING)
    } else {
        AppError::msg(format!("Could not start Git: {error}"))
    }
}

pub(super) fn read_git_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> AppResult<bool> {
    loop {
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
        if !buf.is_empty() {
            return Ok(true);
        }
    }
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
        #[cfg(windows)]
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
            validate_git_choice("rebaseraven-no-such-dir/git.exe")
                .unwrap_err()
                .to_string(),
            crate::error::GIT_MISSING
        );
    }

    #[test]
    fn keeps_distinct_git_executables() {
        let paths = normalize_extra_git_paths(vec![
            "/opt/first/git".into(),
            "/opt/first/git".into(),
            "git-lfs.exe".into(),
            "/usr/bin/git".into(),
            "  ".into(),
        ]);
        assert_eq!(
            paths,
            vec!["/opt/first/git".to_string(), "/usr/bin/git".to_string()]
        );
    }

    #[test]
    fn preserves_unix_path_case() {
        assert_eq!(
            same_git_path("/work/Git/git", "/work/git/git"),
            cfg!(windows)
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_windows_executable_separators() {
        assert!(same_git_path(r"C:\Git\cmd\git.exe", "c:/git/cmd/git.exe"));
    }

    #[cfg(unix)]
    #[test]
    fn preserves_backslashes_in_unix_executable_paths() {
        assert!(!same_git_path(
            "/work/with\\slash/git",
            "/work/with/slash/git"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn keeps_the_on_disk_extension_case() {
        let dir = std::env::temp_dir().join(format!("rebaseraven-git-case-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("git.exe");
        std::fs::write(&real, b"").unwrap();
        let found = crate::locate::on_disk_name(dir.join("git.EXE"));
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
        let dir = std::env::temp_dir().join(format!("rebaseraven-not-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(if cfg!(windows) { "git.exe" } else { "git" });
        std::fs::write(&path, b"not a git executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let text = path.to_string_lossy().into_owned();
        let message = super::check_git_executable(&text).unwrap_err().to_string();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(message, "That file is not a Git executable.");
    }

    #[test]
    fn reports_a_removed_git_executable_with_the_recovery_error() {
        let message = super::git_start_error(
            Path::new("rebaseraven-missing-executable/git").as_os_str(),
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );
        assert_eq!(message.to_string(), crate::error::GIT_MISSING);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unix_git_files_without_execute_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rebaseraven-git-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("git");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            validate_git_choice(&path.to_string_lossy())
                .unwrap_err()
                .to_string(),
            crate::error::GIT_MISSING
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn skips_many_empty_records_without_recursing() {
        let mut bytes = vec![b'\n'; 200_000];
        bytes.extend_from_slice(b"record\r\n");
        let mut input = Cursor::new(bytes);
        let mut line = Vec::new();
        assert!(read_git_line(&mut input, &mut line).unwrap());
        assert_eq!(line, b"record");
        assert!(!read_git_line(&mut input, &mut line).unwrap());
    }

    #[test]
    fn retains_only_recent_progress_and_bounded_diagnostics() {
        let mut logs = VecDeque::new();
        for index in 0..100 {
            remember_progress(&mut logs, &index.to_string());
        }
        assert_eq!(logs.len(), MAX_PROGRESS_LINES);
        assert_eq!(logs.front().map(String::as_str), Some("92"));
        let mut output = vec![b'x'; MAX_DIAGNOSTIC_BYTES * 3];
        output.extend_from_slice(b"last error");
        let tail = diagnostic_tail(&mut Cursor::new(output)).unwrap();
        assert_eq!(tail.len(), MAX_DIAGNOSTIC_BYTES);
        assert!(tail.ends_with(b"last error"));
    }

    #[test]
    fn consumes_oversized_progress_records_without_growing_the_buffer() {
        let mut bytes = vec![b'x'; MAX_DIAGNOSTIC_BYTES * 2];
        bytes.extend_from_slice(b"\nnext\n");
        let mut input = Cursor::new(bytes);
        let mut line = Vec::new();
        assert_eq!(
            read_progress_line(&mut input, &mut line).unwrap(),
            MAX_DIAGNOSTIC_BYTES
        );
        assert_eq!(read_progress_line(&mut input, &mut line).unwrap(), 4);
        assert_eq!(line, b"next");
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::io::Write;

    const FIXTURE_ENV: &str = "REBASERAVEN_GIT_PROGRESS_FIXTURE";
    const FIXTURE_TEST: &str = "git::cli::progress_tests::progress_fixture";

    fn fixture(mode: &str) -> Command {
        let mut command = git_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", FIXTURE_TEST, "--nocapture"])
            .env(FIXTURE_ENV, mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn short_limits() -> ProgressLimits {
        ProgressLimits {
            idle: Duration::from_millis(120),
            total: Duration::from_secs(2),
        }
    }

    fn active_limits() -> ProgressLimits {
        ProgressLimits {
            idle: Duration::from_millis(600),
            total: Duration::from_secs(5),
        }
    }

    #[test]
    fn progress_fixture() {
        let Ok(mode) = std::env::var(FIXTURE_ENV) else {
            return;
        };
        match mode.as_str() {
            "silent" => thread::sleep(Duration::from_secs(60)),
            "manual" => thread::sleep(Duration::from_millis(240)),
            "stdout" | "stderr" => {
                for _ in 0..20 {
                    if mode == "stdout" {
                        std::io::stdout().write_all(b"x").unwrap();
                        std::io::stdout().flush().unwrap();
                    } else {
                        std::io::stderr().write_all(b"x").unwrap();
                        std::io::stderr().flush().unwrap();
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            "flood" => loop {
                eprintln!("transfer progress {}", "x".repeat(1000));
            },
            "inherited-stdout" | "inherited-stderr" => {
                // A descendant of the command inherits its owned job/process
                // group. Do not give this fixture another process group.
                let mut child = Command::new(std::env::current_exe().unwrap());
                child
                    .args(["--exact", FIXTURE_TEST, "--nocapture"])
                    .env(FIXTURE_ENV, "silent")
                    .stdin(Stdio::null())
                    .stdout(if mode == "inherited-stdout" {
                        Stdio::inherit()
                    } else {
                        Stdio::null()
                    })
                    .stderr(if mode == "inherited-stderr" {
                        Stdio::inherit()
                    } else {
                        Stdio::null()
                    });
                // The runner owns and terminates this intentionally surviving
                // fixture, even after this launcher has exited.
                let helper = child.spawn().unwrap();
                if let Some(path) = std::env::var_os("REBASERAVEN_GIT_PROGRESS_HELPER_PID") {
                    fs::write(path, helper.id().to_string()).unwrap();
                }
                std::process::exit(0);
            }
            _ => panic!("Unknown fixture mode"),
        }
    }

    #[test]
    fn background_fetch_stops_a_silent_helper() {
        let started = Instant::now();
        let error = run_progress_command(
            &mut fixture("silent"),
            None,
            Some(short_limits()),
            &mut |_| {},
            None,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), BACKGROUND_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn background_fetch_timeout_keeps_polling_after_both_pipes_close() {
        let mut command = fixture("silent");
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let started = Instant::now();
        let error =
            run_progress_command(&mut command, None, Some(short_limits()), &mut |_| {}, None)
                .unwrap_err();
        assert_eq!(error.to_string(), BACKGROUND_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn background_fetch_bounds_helpers_that_keep_only_one_pipe_open() {
        for mode in ["inherited-stdout", "inherited-stderr"] {
            let temporary = tempfile::tempdir().unwrap();
            let helper_pid = temporary.path().join("helper-pid");
            let mut independent = fixture("silent")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let started = Instant::now();
            let result = run_progress_command(
                fixture(mode).env("REBASERAVEN_GIT_PROGRESS_HELPER_PID", &helper_pid),
                None,
                Some(active_limits()),
                &mut |_| {},
                None,
            );
            let unrelated_alive = independent.try_wait().unwrap().is_none();
            stop_child(&mut independent);
            assert_eq!(result.unwrap_err().to_string(), BACKGROUND_TIMEOUT);
            assert!(started.elapsed() < Duration::from_secs(3));
            assert!(unrelated_alive, "An unrelated process must not be stopped");
            assert!(
                helper_pid.exists(),
                "The launcher must create its inherited-pipe helper"
            );
        }
    }

    #[test]
    fn background_fetch_counts_stdout_and_unterminated_stderr_as_activity() {
        for mode in ["stdout", "stderr"] {
            run_progress_command(
                &mut fixture(mode),
                None,
                Some(active_limits()),
                &mut |_| {},
                None,
            )
            .unwrap();
        }
    }

    #[test]
    fn background_fetch_has_a_total_limit_even_while_output_continues() {
        let error = run_progress_command(
            &mut fixture("stdout"),
            None,
            Some(ProgressLimits {
                idle: Duration::from_secs(2),
                total: Duration::from_millis(600),
            }),
            &mut |_| {},
            None,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), BACKGROUND_TIMEOUT);
    }

    #[test]
    fn a_manual_operation_has_no_background_deadline() {
        run_progress_command(&mut fixture("manual"), None, None, &mut |_| {}, None).unwrap();
    }

    #[test]
    fn cancellation_keeps_polling_after_stderr_or_both_pipes_close() {
        for close_stdout in [false, true] {
            let cancel = Arc::new(AtomicBool::new(false));
            let trigger = cancel.clone();
            let cancellation = thread::spawn(move || {
                thread::sleep(Duration::from_millis(80));
                trigger.store(true, Ordering::Relaxed);
            });
            let mut command = fixture("silent");
            command.stderr(Stdio::null());
            if close_stdout {
                command.stdout(Stdio::null());
            }
            let started = Instant::now();
            let result = run_progress_command(&mut command, Some(cancel), None, &mut |_| {}, None);
            cancellation.join().unwrap();
            assert!(result.unwrap_err().is_cancelled());
            assert!(started.elapsed() < Duration::from_secs(3));
        }
    }

    #[test]
    fn a_saturated_progress_channel_does_not_block_cancellation() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        let mut received = 0;
        let result = run_progress_command(
            &mut fixture("flood"),
            Some(cancel),
            Some(active_limits()),
            &mut |_| {
                received += 1;
                if received >= 5 {
                    trigger.store(true, Ordering::Relaxed);
                }
            },
            None,
        );
        assert!(received >= 5);
        assert!(result.unwrap_err().is_cancelled());
    }
}
