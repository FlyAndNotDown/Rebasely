//! Runs the `p4` executable the same way a terminal would.
//!
//! Flags on the command line carry the workspace (`-p`, `-u`, `-c`), so an
//! inherited `P4CONFIG` cannot silently switch servers mid-command.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use crate::diagnostics::{self, Code, CommandOutput, Status};
use crate::error::{AppError, AppResult, P4_LOGIN, P4_MISSING, P4_PROBE_TIMEOUT as PROBE_TIMEOUT};

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
        && bin
            .resolved
            .as_ref()
            .is_some_and(|path| crate::locate::is_executable(path))
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
    if is_p4_executable_name(&path) && crate::locate::is_executable(&path) {
        Some(path)
    } else {
        None
    }
}

fn find_p4() -> Option<PathBuf> {
    let mut bin = p4_bin().lock().unwrap_or_else(|err| err.into_inner());
    if bin
        .resolved
        .as_ref()
        .is_some_and(|path| crate::locate::is_executable(path))
    {
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

pub fn validate_p4_choice(path: &str) -> AppResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(());
    }
    let file = Path::new(path);
    if !is_p4_executable_name(file) {
        return Err(AppError::msg("Choose a file named p4."));
    }
    if !crate::locate::is_executable(file) {
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

pub(crate) fn kill_pid(pid: u32) {
    crate::platform::kill_process_tree(pid);
}

/// One `p4` invocation that a newer call can cancel.
///
/// Depot filename search scans a large `db.rev` range. Typing again has to
/// kill the previous child or several full scans pile up on the server.
pub struct P4Job {
    generation: AtomicU64,
    pid: Mutex<Option<u32>>,
}

impl P4Job {
    pub const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            pid: Mutex::new(None),
        }
    }

    pub fn cancel(&self) {
        self.advance();
    }

    pub fn begin(&self) -> u64 {
        self.advance()
    }

    pub fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn run(&self, env: &P4Env, args: &[&str], generation: u64) -> AppResult<Option<String>> {
        if self.current() != generation {
            return Ok(None);
        }
        let Some(output) = self.spawn_wait(env, args, generation)? else {
            return Ok(None);
        };
        if self.current() != generation {
            return Ok(None);
        }
        match finish(output) {
            Ok(text) if self.current() == generation => Ok(Some(text)),
            Ok(_) => Ok(None),
            Err(_) if self.current() != generation => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn advance(&self) -> u64 {
        let mut current = self.pid.lock().unwrap_or_else(|err| err.into_inner());
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let previous = current.take();
        drop(current);
        if let Some(pid) = previous {
            kill_pid(pid);
        }
        generation
    }

    fn clear_pid(&self, pid: u32) {
        let mut current = self.pid.lock().unwrap_or_else(|err| err.into_inner());
        if *current == Some(pid) {
            *current = None;
        }
    }

    fn spawn_wait(
        &self,
        env: &P4Env,
        args: &[&str],
        generation: u64,
    ) -> AppResult<Option<std::process::Output>> {
        if self.current() != generation {
            return Ok(None);
        }
        let program = require_p4()?;
        let mut command = prepared(program, env, args);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|err| p4_start_error(command.get_program(), err))?;
        let pid = child.id();
        let mut current = self.pid.lock().unwrap_or_else(|err| err.into_inner());
        if self.current() != generation {
            drop(current);
            kill_pid(pid);
            let _ = child.wait();
            return Ok(None);
        }
        *current = Some(pid);
        drop(current);
        match child.wait_with_output() {
            Ok(output) => {
                self.clear_pid(pid);
                if self.current() != generation {
                    Ok(None)
                } else {
                    Ok(Some(output))
                }
            }
            Err(err) => {
                self.clear_pid(pid);
                if self.current() != generation {
                    Ok(None)
                } else {
                    Err(AppError::msg(err.to_string()))
                }
            }
        }
    }
}

#[derive(Default)]
struct P4Jobs {
    jobs: Mutex<HashMap<P4Env, Weak<P4Job>>>,
}

impl P4Jobs {
    fn get(&self, env: &P4Env) -> Arc<P4Job> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|err| err.into_inner());
        jobs.retain(|_, job| job.strong_count() != 0);
        if let Some(job) = jobs.get(env).and_then(Weak::upgrade) {
            return job;
        }
        let job = Arc::new(P4Job::new());
        jobs.insert(env.clone(), Arc::downgrade(&job));
        job
    }

    fn cancel(&self, env: &P4Env) {
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(env)
            .and_then(Weak::upgrade);
        if let Some(job) = job {
            job.cancel();
        }
    }
}

fn depot_search_jobs() -> &'static P4Jobs {
    static JOBS: OnceLock<P4Jobs> = OnceLock::new();
    JOBS.get_or_init(P4Jobs::default)
}

pub fn depot_search_job(env: &P4Env) -> Arc<P4Job> {
    depot_search_jobs().get(env)
}

pub fn cancel_depot_search(env: &P4Env) {
    depot_search_jobs().cancel(env);
}

fn p4_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    crate::platform::background_command(program)
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct P4Env {
    pub cwd: PathBuf,
    pub port: String,
    pub user: String,
    pub client: String,
    pub charset: String,
}

pub fn run_p4(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<std::process::Output> {
    let started = Instant::now();
    let output = run_once(env, args, input);
    let code = diagnostic_code(args);
    diagnostics::record_cli_output(code, args, started, &output, |output| {
        output.status.success()
    });
    output
}

fn diagnostic_code(args: &[&str]) -> Code {
    let verb = args.iter().copied().find(|arg| !arg.starts_with('-'));
    match verb {
        Some("info") => Code::PerforceInfo,
        Some("opened" | "fstat") => Code::PerforceStatus,
        Some("changes" | "describe" | "filelog") => Code::PerforceHistory,
        Some("diff" | "diff2") => Code::PerforceDiff,
        Some("sync") if args.contains(&"-n") => Code::PerforceSyncPreview,
        Some("sync") if !args.contains(&"-N") => Code::PerforceSync,
        Some("submit") => Code::PerforceSubmit,
        Some("login") => Code::PerforceLogin,
        Some("resolve") if !args.contains(&"-n") => Code::PerforceResolve,
        Some("change") if args.contains(&"-i") || args.contains(&"-d") => Code::PerforceChange,
        Some("shelve" | "unshelve") => Code::PerforceShelf,
        Some("revert") => Code::PerforceRevert,
        Some(
            "edit" | "add" | "delete" | "reopen" | "move" | "reconcile" | "integrate" | "undo",
        ) if !args.contains(&"-n") => Code::PerforceOpen,
        _ => Code::PerforceOperation,
    }
}

pub fn run_p4_ok(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<String> {
    run_p4(env, args, input).and_then(finish)
}

// Passive repository discovery must never wait for an unrelated server or a
// selected executable wrapper. Keep its limits separate from user operations.
const PROBE_OUTPUT_LIMIT: usize = 65_536;

pub(super) fn run_p4_probe(env: &P4Env, args: &[&str], deadline: Instant) -> AppResult<String> {
    if !matches!(args, ["set"] | ["-ztag", "info"]) {
        return Err(AppError::msg("That command is not a repository probe."));
    }
    let started = Instant::now();
    let output =
        require_p4().and_then(|program| probe_output(&mut prepared(program, env, args), deadline));
    diagnostics::record_cli_output(Code::PerforceInfo, args, started, &output, |output| {
        output.status.success()
    });
    output.and_then(finish)
}

/// Own the child until its result is collected, so a deadline never targets a
/// recycled PID after an exited parent leaves its helpers holding the pipes.
struct ProbeProcess {
    child: Child,
    tree: crate::platform::ProbeProcessTreeGuard,
    reaped: bool,
}

impl Drop for ProbeProcess {
    fn drop(&mut self) {
        if !self.reaped {
            self.tree.terminate(self.child.id());
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn probe_output(command: &mut Command, deadline: Instant) -> AppResult<std::process::Output> {
    if Instant::now() >= deadline {
        return Err(AppError::msg(PROBE_TIMEOUT));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (child, tree) = crate::platform::spawn_probe_command(command)
        .map_err(|err| p4_start_error(command.get_program(), err))?;
    probe_child(child, tree, deadline)
}

fn probe_child(
    child: Child,
    tree: crate::platform::ProbeProcessTreeGuard,
    deadline: Instant,
) -> AppResult<std::process::Output> {
    let mut process = ProbeProcess {
        child,
        tree,
        reaped: false,
    };
    let (sender, receiver) = mpsc::channel();
    for (stdout, pipe) in [
        (
            true,
            Box::new(process.child.stdout.take().expect("piped stdout")) as Box<dyn Read + Send>,
        ),
        (
            false,
            Box::new(process.child.stderr.take().expect("piped stderr")) as Box<dyn Read + Send>,
        ),
    ] {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut bytes = Vec::with_capacity(PROBE_OUTPUT_LIMIT + 1);
            let result = pipe
                .take((PROBE_OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut bytes);
            let _ = sender.send((stdout, result.map(|_| bytes)));
        });
    }
    drop(sender);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    for _ in 0..2 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (is_stdout, bytes) = receiver
            .recv_timeout(remaining)
            .map_err(|_| AppError::msg(PROBE_TIMEOUT))?;
        let bytes = bytes?;
        if bytes.len() > PROBE_OUTPUT_LIMIT {
            return Err(AppError::msg(
                "Perforce workspace discovery output is too large.",
            ));
        }
        if is_stdout {
            stdout = bytes;
        } else {
            stderr = bytes;
        }
    }
    let status = loop {
        if let Some(status) = process.child.try_wait()? {
            process.reaped = true;
            break status;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AppError::msg(PROBE_TIMEOUT));
        }
        thread::sleep(remaining.min(Duration::from_millis(5)));
    };
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// `p4 diff` can exit non-zero when the files differ. A diff body is still a result.
pub fn run_p4_diff(env: &P4Env, args: &[&str]) -> AppResult<String> {
    let started = Instant::now();
    let output = run_once(env, args, None);
    let Ok(output) = output else {
        diagnostics::record_cli_output(Code::PerforceDiff, args, started, &output, |_| false);
        return output.and_then(finish);
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let result = finish_diff(output.status.success(), stdout, stderr);
    diagnostics::record_cli(
        Code::PerforceDiff,
        args,
        started,
        Status::of(&result),
        (&output).into(),
        None,
    );
    result
}

/// File previews are bounded independently of normal command and progress output.
pub fn read_file_prefix(env: &P4Env, spec: &str, limit: usize) -> AppResult<(Vec<u8>, bool)> {
    let mut command = prepared(require_p4()?, env, &["print", "-q", spec]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| p4_start_error(command.get_program(), err))?;
    let stderr = child.stderr.take();
    let errors = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.by_ref().take(65_536).read_to_end(&mut bytes);
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        }
        bytes
    });
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .expect("piped stdout")
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut bytes);
    let truncated = bytes.len() > limit;
    if truncated || read.is_err() {
        kill_pid(child.id());
    }
    let status = child.wait();
    let stderr = errors.join().unwrap_or_default();
    read?;
    let status = status?;
    if !truncated {
        finish_parts(
            status.success(),
            String::new(),
            String::from_utf8_lossy(&stderr).into_owned(),
        )?;
    }
    bytes.truncate(limit);
    Ok((bytes, truncated))
}

fn finish_diff(ok: bool, stdout: String, stderr: String) -> AppResult<String> {
    if ok || looks_like_diff(&stdout) {
        return Ok(stdout);
    }
    finish_parts(false, stdout, stderr)
}

pub fn run_p4_stream(
    env: &P4Env,
    args: &[&str],
    mut on_line: impl FnMut(String),
) -> AppResult<String> {
    let started = Instant::now();
    let code = diagnostic_code(args);
    match stream_once(env, args, &mut on_line) {
        Ok((status, stdout, stderr)) => {
            let ok = status.success();
            diagnostics::record_cli(
                code,
                args,
                started,
                if ok { Status::Success } else { Status::Failure },
                CommandOutput {
                    status: Some(status),
                    stdout: stdout.as_bytes(),
                    stderr: stderr.as_bytes(),
                },
                None,
            );
            finish_parts(ok, stdout, stderr)
        }
        Err(error) => {
            diagnostics::record_cli(
                code,
                args,
                started,
                Status::Failure,
                CommandOutput::default(),
                Some(&error),
            );
            Err(error)
        }
    }
}

fn finish(output: std::process::Output) -> AppResult<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    finish_parts(output.status.success(), stdout, stderr)
}

fn finish_parts(ok: bool, stdout: String, stderr: String) -> AppResult<String> {
    let message = combine(&stderr, &stdout);
    if !ok {
        reject_untrusted_server(&message)?;
    }
    if !ok && needs_login(&message) {
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
        .map_err(|err| p4_start_error(command.get_program(), err))?;
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
) -> AppResult<(std::process::ExitStatus, String, String)> {
    let program = require_p4()?;
    let mut command = prepared(program, env, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| p4_start_error(command.get_program(), err))?;
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
            on_line(crate::error::redact_credentials(&line));
        }
    }
    let status = child.wait().map_err(|err| AppError::msg(err.to_string()))?;
    let stderr_bytes = stderr_thread.join().unwrap_or_default();
    let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
    Ok((status, stdout_text, stderr_text))
}

fn prepared(program: PathBuf, env: &P4Env, args: &[&str]) -> Command {
    let mut command = p4_command(program);
    if env.cwd.as_os_str().is_empty() {
        // Detection can run before a client root exists.
    } else if env.cwd.is_dir() {
        command.current_dir(&env.cwd);
        // On Unix p4 prefers an inherited PWD over the process working directory.
        command.arg("-d").arg(&env.cwd);
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

fn p4_start_error(program: &std::ffi::OsStr, error: std::io::Error) -> AppError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
    ) && !crate::locate::is_executable(Path::new(program))
    {
        AppError::msg(P4_MISSING)
    } else {
        AppError::msg(format!("Could not start Perforce: {error}"))
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

fn reject_untrusted_server(message: &str) -> AppResult<()> {
    if needs_trust(message) {
        return Err(AppError::msg(
            "Perforce server identity is not trusted. Verify the server fingerprint with your administrator, then establish trust with p4 before reconnecting.",
        ));
    }
    Ok(())
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
    use super::{
        is_p4_executable_name, normalize_extra_p4_paths, prepared, validate_p4_choice, P4Env,
        P4Jobs,
    };
    use std::path::Path;
    use std::sync::Arc;

    #[cfg(unix)]
    #[test]
    fn discovery_deadline_cancels_children_and_helpers_holding_output_pipes() {
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        let temporary = tempfile::tempdir().unwrap();
        let marker = temporary.path().join("helper-survived");
        let mut command = crate::platform::background_command("/bin/sh");
        command
            .args([
                "-c",
                "(sleep 0.2; printf orphan > \"$1\") & exit 0",
                "probe-fixture",
            ])
            .arg(&marker)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (child, tree) = crate::platform::spawn_probe_command(&mut command).unwrap();
        let pid = child.id();
        let started = Instant::now();
        let error =
            super::probe_child(child, tree, started + Duration::from_millis(75)).unwrap_err();
        assert_eq!(error.to_string(), super::PROBE_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_err());
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !marker.exists(),
            "the probe left its pipe-holding helper running"
        );
    }

    #[cfg(unix)]
    #[test]
    fn discovery_bounds_output_and_keeps_successful_output_intact() {
        use std::time::{Duration, Instant};

        let mut command = crate::platform::background_command("/bin/sh");
        command.args(["-c", "printf 'workspace\\n'; printf 'diagnostic\\n' >&2"]);
        let output =
            super::probe_output(&mut command, Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"workspace\n");
        assert_eq!(output.stderr, b"diagnostic\n");

        for pipe in ["", " >&2"] {
            let mut command = crate::platform::background_command("/bin/sh");
            command.args([
                "-c",
                &format!("while :; do printf '0123456789abcdef0123456789abcdef'{pipe}; done"),
            ]);
            let error = super::probe_output(&mut command, Instant::now() + Duration::from_secs(2))
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Perforce workspace discovery output is too large."
            );
        }
    }

    #[test]
    fn discovery_does_not_launch_after_its_shared_deadline_or_accept_mutations() {
        let mut command = crate::platform::background_command("not-a-probe-executable");
        let error = super::probe_output(&mut command, std::time::Instant::now()).unwrap_err();
        assert_eq!(error.to_string(), super::PROBE_TIMEOUT);
        let env = P4Env {
            cwd: std::path::PathBuf::new(),
            port: String::new(),
            user: String::new(),
            client: String::new(),
            charset: String::new(),
        };
        for args in [
            &["set", "P4PORT=other.example.com:1666"][..],
            &["trust", "-y"][..],
            &["sync"][..],
        ] {
            let error = super::run_p4_probe(&env, args, std::time::Instant::now()).unwrap_err();
            assert_eq!(error.to_string(), "That command is not a repository probe.");
        }
    }

    #[test]
    fn workspace_commands_override_the_launch_directory_and_connection() {
        let temporary = tempfile::tempdir().unwrap();
        let env = P4Env {
            cwd: temporary.path().to_path_buf(),
            port: "ssl:perforce.example.com:1666".into(),
            user: "alice".into(),
            client: "dev-pc".into(),
            charset: "utf8".into(),
        };
        let command = prepared("p4".into(), &env, &["reconcile", "-e", "-a", "-d"]);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(command.get_current_dir(), Some(temporary.path()));
        assert_eq!(args[0], "-d");
        assert_eq!(args[1], temporary.path());
        assert_eq!(
            &args[2..],
            [
                "-p",
                "ssl:perforce.example.com:1666",
                "-u",
                "alice",
                "-c",
                "dev-pc",
                "-C",
                "utf8",
                "reconcile",
                "-e",
                "-a",
                "-d",
            ]
        );
    }

    #[test]
    fn depot_search_replacements_and_cancellation_stay_in_their_workspace() {
        let jobs = P4Jobs::default();
        let first = P4Env {
            cwd: Path::new("/work/client").to_path_buf(),
            port: "ssl:perforce.example.com:1666".into(),
            user: "alice".into(),
            client: "dev-pc".into(),
            charset: "utf8".into(),
        };
        let first_job = jobs.get(&first);
        let first_generation = first_job.begin();

        let mut second = first.clone();
        second.client = "build-pc".into();
        let second_job = jobs.get(&second);
        let second_generation = second_job.begin();
        assert!(!Arc::ptr_eq(&first_job, &second_job));
        assert_eq!(first_job.current(), first_generation);

        let replacement = jobs.get(&first);
        assert!(Arc::ptr_eq(&first_job, &replacement));
        assert_ne!(replacement.begin(), first_generation);
        assert_eq!(second_job.current(), second_generation);

        jobs.cancel(&first);
        assert_eq!(second_job.current(), second_generation);
        jobs.cancel(&second);
        assert_ne!(second_job.current(), second_generation);

        for index in 0..4 {
            let mut different = first.clone();
            match index {
                0 => different.cwd = Path::new("/work/other").to_path_buf(),
                1 => different.port = "ssl:other.example.com:1666".into(),
                2 => different.user = "bob".into(),
                _ => different.charset.clear(),
            }
            assert!(!Arc::ptr_eq(&first_job, &jobs.get(&different)));
        }
    }

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
            "/opt/perforce/p4".into(),
            "/opt/perforce/p4".into(),
            "/opt/perforce/p4v".into(),
        ]);
        assert_eq!(extras, vec!["/opt/perforce/p4".to_string()]);
    }

    #[test]
    fn does_not_accept_unverified_tls_fingerprints() {
        let message = super::finish_parts(
            false,
            String::new(),
            "Run p4 trust to verify authenticity of the server.".into(),
        )
        .unwrap_err()
        .to_string();
        assert!(message.contains("Verify the server fingerprint"));
        assert!(!message.contains("trust -y"));
        assert!(super::finish_parts(true, "normal result".into(), String::new()).is_ok());
    }

    #[test]
    fn file_content_cannot_trigger_credential_or_trust_prompts() {
        let content = "@@ -1 +1 @@\n-session has expired\n+please login and run p4 trust\n";
        assert_eq!(
            super::finish_diff(false, content.into(), String::new()).unwrap(),
            content
        );
        assert_eq!(
            super::finish_parts(true, "please login".into(), String::new()).unwrap(),
            "please login"
        );
        assert_eq!(
            super::finish_diff(false, String::new(), "Your session has expired.".into())
                .unwrap_err()
                .to_string(),
            crate::error::P4_LOGIN
        );
    }

    #[test]
    fn keeps_unix_executable_paths_distinct_by_case() {
        assert_eq!(
            super::same_p4_path("/work/P4/p4", "/work/p4/p4"),
            cfg!(windows)
        );
    }

    #[test]
    fn reports_a_removed_p4_executable_with_the_recovery_error() {
        let error = super::p4_start_error(
            Path::new("rebaseraven-missing-executable/p4").as_os_str(),
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );
        assert_eq!(error.to_string(), crate::error::P4_MISSING);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unix_p4_files_without_execute_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rebaseraven-p4-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p4");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            validate_p4_choice(&path.to_string_lossy())
                .unwrap_err()
                .to_string(),
            crate::error::P4_MISSING
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
