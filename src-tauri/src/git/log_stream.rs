use super::*;

use std::process::{Child, ChildStdout};
use std::time::Instant;

/// A stream nobody has read for this long is closed so its `git log` process
/// does not keep the repository folder busy.
const STREAM_IDLE: Duration = Duration::from_secs(120);

struct LogStream {
    args: Vec<String>,
    child: Child,
    reader: BufReader<ChildStdout>,
    position: usize,
    used: Instant,
}

impl Drop for LogStream {
    fn drop(&mut self) {
        stop_child(&mut self.child);
    }
}

type Slot = Arc<Mutex<Option<LogStream>>>;

fn slots() -> &'static Mutex<HashMap<PathBuf, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<PathBuf, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(|| {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_secs(30));
            close_idle_log_streams();
        });
        Mutex::new(HashMap::new())
    })
}

fn slot_for(root: &Path) -> Slot {
    let mut map = slots().lock().unwrap_or_else(|err| err.into_inner());
    map.entry(root.to_path_buf()).or_default().clone()
}

fn close_idle_log_streams() {
    let map = slots().lock().unwrap_or_else(|err| err.into_inner());
    for slot in map.values() {
        if let Ok(mut stream) = slot.try_lock() {
            if stream
                .as_ref()
                .is_some_and(|item| item.used.elapsed() > STREAM_IDLE)
            {
                *stream = None;
            }
        }
    }
}

fn root_key(path: &str) -> String {
    let path = strip_verbatim_prefix(path);
    let slash = if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path
    };
    let slash = slash.trim_end_matches('/').to_string();
    if cfg!(windows) {
        slash.to_lowercase()
    } else {
        slash
    }
}

/// Closes the history streams of repositories that are no longer open.
pub fn retain_log_streams(open: &[String]) {
    let open: Vec<String> = open.iter().map(|path| root_key(path)).collect();
    let mut map = slots().lock().unwrap_or_else(|err| err.into_inner());
    map.retain(|root, _| open.contains(&root_key(&root.to_string_lossy())));
}

/// Returns `limit` lines of `git <args>` output starting at line `skip`.
///
/// Date-ordered `git log` walks the whole graph before printing its first line,
/// and `--skip` repeats that walk for every page. Instead the process for a
/// repository stays open between pages, so only the first page pays for it.
pub(super) fn log_page(
    root: &Path,
    args: &[String],
    skip: usize,
    limit: usize,
) -> AppResult<Vec<u8>> {
    let slot = slot_for(root);
    let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
    let reusable = skip > 0
        && guard
            .as_ref()
            .is_some_and(|stream| stream.args == args && stream.position == skip);
    if !reusable {
        *guard = None;
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut child = spawn_git_stdout(root, &argv)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::msg("Could not read git log"))?;
        *guard = Some(LogStream {
            args: args.to_vec(),
            child,
            reader: BufReader::new(stdout),
            position: 0,
            used: Instant::now(),
        });
    }
    let stream = guard.as_mut().expect("stream was just opened");
    let mut line = Vec::new();
    // A fresh stream asked for a later page catches up by reading through.
    while stream.position < skip {
        if !read_git_line(&mut stream.reader, &mut line)? {
            break;
        }
        stream.position += 1;
    }
    let mut page = Vec::new();
    let mut count = 0;
    let mut ended = false;
    while count < limit {
        if !read_git_line(&mut stream.reader, &mut line)? {
            ended = true;
            break;
        }
        page.extend_from_slice(&line);
        page.push(b'\n');
        count += 1;
    }
    stream.position += count;
    stream.used = Instant::now();
    if ended {
        let status = stream.child.wait()?;
        *guard = None;
        if !status.success() {
            return Err(AppError::msg("git log failed"));
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::root_key;

    #[test]
    fn preserves_case_sensitive_repository_names() {
        assert_eq!(
            root_key("/work/Repo") == root_key("/work/repo"),
            cfg!(windows)
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_backslashes_in_unix_repository_names() {
        assert_ne!(root_key("/work/with\\slash"), root_key("/work/with/slash"));
    }
}
