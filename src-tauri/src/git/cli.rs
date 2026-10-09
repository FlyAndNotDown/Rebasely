use super::*;

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

/// Runs git with `input` on stdin, so messages and path lists never hit the
/// command-line length limit or need quoting.
pub(super) fn run_git_input(root: &Path, args: &[&str], input: &[u8]) -> AppResult<Vec<u8>> {
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
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(git_output_error(output))
}

/// Runs a git command that takes pathspecs, passing them NUL-separated on
/// stdin and matching them literally.
pub(super) fn run_git_pathspecs(root: &Path, args: &[&str], paths: &[String]) -> AppResult<Vec<u8>> {
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
    loop {
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

    let status = child
        .wait()
        .map_err(|err| AppError::msg(err.to_string()))?;
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    let stdout_bytes = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
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

pub(super) fn read_progress_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> std::io::Result<usize> {
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
