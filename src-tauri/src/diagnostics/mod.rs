mod archive;
mod command;
mod event;

pub use command::CommandOutput;
use command::{excerpt, CommandReport};
use event::Event;
pub use event::{Code, Status};

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::Record;
use log4rs::{
    append::{
        file::FileAppender,
        rolling_file::policy::compound::roll::{fixed_window::FixedWindowRoller, Roll},
        Append,
    },
    encode::pattern::PatternEncoder,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const FILE_BYTES: usize = 5 * 1024 * 1024;
const RETENTION_DAYS: u64 = 7;
const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
const LOG_NAMES: [&str; 10] = [
    "events.log",
    "events.1.log",
    "events.2.log",
    "events.3.log",
    "events.4.log",
    "events.5.log",
    "events.6.log",
    "events.7.log",
    "events.8.log",
    "events.9.log",
];
const MAX_LOG_BYTES: usize = FILE_BYTES * LOG_NAMES.len();
const MAX_DURATION_MS: u64 = 86_400_000;
const MAX_TIMESTAMP_MS: u64 = 4_102_444_800_000;
const ISSUES_URL: &str = "https://github.com/FlyAndNotDown/RebaseRaven/issues";
static EVENTS: OnceLock<mpsc::SyncSender<Work>> = OnceLock::new();

enum Work {
    Append(Event),
    Clear(mpsc::Sender<io::Result<()>>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    total_bytes: u64,
    file_count: usize,
    max_bytes: usize,
    retention_days: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    file_count: usize,
    skipped_entries: usize,
}

/// Starts one low-priority writer; failed diagnostics never prevent startup.
/// Call once during setup. Disk work stays on this thread or a blocking command.
pub fn initialize(app: &AppHandle) -> AppResult<()> {
    if EVENTS.get().is_some() {
        return Ok(());
    }
    let directory = log_directory(app)?;
    let (sender, receiver) = mpsc::sync_channel(64);
    std::thread::Builder::new()
        .name("local-diagnostics".into())
        .spawn(move || write_logs(&directory, receiver))
        .map_err(|_| AppError::msg("Could not start local diagnostics."))?;
    let _ = EVENTS.set(sender);
    record(Code::AppStarted, Status::Success, None);
    Ok(())
}

fn write_logs(directory: &Path, receiver: mpsc::Receiver<Work>) {
    let mut limiter = RateLimit::default();
    let mut next_prune = Instant::now();
    loop {
        let wait = next_prune.saturating_duration_since(Instant::now());
        let event = match receiver.recv_timeout(wait) {
            Ok(Work::Append(event)) => Some(event),
            Ok(Work::Clear(reply)) => {
                // Earlier writes have already drained, so they cannot restore cleared logs.
                let result = clear_stores(directory);
                limiter = RateLimit::default();
                let _ = reply.send(result);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let now = Instant::now();
        let prune = now >= next_prune;
        let event = event.filter(|event| limiter.allow(event, now));
        if prune {
            next_prune = now + PRUNE_INTERVAL;
        }
        if prune || event.is_some() {
            if let Ok(store) = Store::new(directory) {
                if prune {
                    let _ = store.prune(retention_cutoff());
                }
                if let Some(event) = event {
                    let _ = store.append(&event);
                }
            }
        }
    }
}

/// Successful fast reads stay quiet.
pub fn record_slow_or_failed<T>(code: Code, started: Instant, result: &AppResult<T>) {
    if result.is_err() || started.elapsed() >= Duration::from_secs(1) {
        enqueue(code, Status::of(result), Some(started.elapsed()), || {
            (result.as_ref().err().and_then(error_excerpt), None)
        });
    }
}

pub fn record_cli_output(
    code: Code,
    args: &[&str],
    started: Instant,
    result: &AppResult<Output>,
    success: impl FnOnce(&Output) -> bool,
) {
    match result {
        Ok(output) => record_cli(
            code,
            args,
            started,
            if success(output) {
                Status::Success
            } else {
                Status::Failure
            },
            output.into(),
            None,
        ),
        Err(error) => record_cli(
            code,
            args,
            started,
            Status::of(result),
            CommandOutput::default(),
            Some(error),
        ),
    }
}

pub fn record_cli(
    code: Code,
    args: &[&str],
    started: Instant,
    status: Status,
    output: CommandOutput<'_>,
    error: Option<&AppError>,
) {
    let elapsed = started.elapsed();
    if !code.passive() || status != Status::Success || elapsed >= Duration::from_secs(1) {
        enqueue(code, status, Some(elapsed), || {
            let command = CommandReport::new(code.category(), args, output);
            (error.and_then(error_excerpt), Some(command))
        });
    }
}

fn error_excerpt(error: &AppError) -> Option<String> {
    match error {
        AppError::Message(message) => excerpt(message.as_bytes()),
        AppError::Io(error) => excerpt(error.to_string().as_bytes()),
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(MAX_TIMESTAMP_MS)) as u64
}

fn retention_cutoff() -> u64 {
    unix_ms().saturating_sub(RETENTION_DAYS * 86_400_000)
}

/// Record an application milestone without command data.
pub fn record(code: Code, status: Status, duration: Option<Duration>) {
    enqueue(code, status, duration, || (None, None));
}

fn enqueue(
    code: Code,
    status: Status,
    duration: Option<Duration>,
    details: impl FnOnce() -> (Option<String>, Option<CommandReport>),
) {
    if let Some(sender) = EVENTS.get() {
        let (reason, command) = details();
        let _ = sender.try_send(Work::Append(Event {
            time_unix_ms: unix_ms(),
            code,
            status,
            duration_ms: duration
                .map(|value| value.as_millis().min(u128::from(MAX_DURATION_MS)) as u64),
            reason,
            command,
        }));
    }
}

pub fn summary(app: &AppHandle) -> AppResult<Summary> {
    let directory = log_directory(app)?;
    Store::new(&directory)
        .and_then(|store| store.summary())
        .map_err(|_| AppError::msg("Could not read local diagnostics. Try again."))
}

pub fn clear(app: &AppHandle) -> AppResult<()> {
    let result = if let Some(writer) = EVENTS.get() {
        let (reply, response) = mpsc::channel();
        writer
            .send(Work::Clear(reply))
            .map_err(|_| invalid_store())
            .and_then(|_| response.recv().unwrap_or_else(|_| Err(invalid_store())))
    } else {
        clear_stores(&log_directory(app)?)
    };
    result.map_err(|_| AppError::msg("Could not clear all diagnostic logs. Try again."))
}

pub fn export(app: &AppHandle, destination: &Path) -> AppResult<ExportResult> {
    let directory = log_directory(app)?;
    let result = Store::new(&directory).and_then(|store| store.export(destination));
    record(
        Code::DiagnosticsExport,
        if result.is_ok() {
            Status::Success
        } else {
            Status::Failure
        },
        None,
    );
    result.map_err(|_| {
        AppError::msg("Could not export diagnostics. Choose a writable ZIP file and try again.")
    })
}

pub fn open_directory(app: &AppHandle) -> AppResult<()> {
    let directory = log_directory(app)?;
    let store = Store::new(&directory)
        .map_err(|_| AppError::msg("Could not open the local diagnostics folder."))?;
    crate::platform::open_path(&store.directory)
        .map_err(|_| AppError::msg("Could not open the local diagnostics folder."))
}

pub fn open_issues() -> AppResult<()> {
    crate::platform::open_url(ISSUES_URL)
}

fn log_directory(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_log_dir()
        .map(|directory| directory.join("diagnostics-v3"))
        .map_err(|_| AppError::msg("The local diagnostics folder is unavailable."))
}

fn clear_stores(directory: &Path) -> io::Result<()> {
    let parent = directory.parent().ok_or_else(invalid_store)?;
    let current = Store::new(directory).and_then(|store| store.clear_files(LOG_NAMES));
    let previous = clear_previous_store(&parent.join("diagnostics-v2"), LOG_NAMES);
    let jsonl = clear_previous_store(
        &parent.join("diagnostics-v1"),
        std::iter::once("events.jsonl".to_owned())
            .chain((1..32).map(|index| format!("events.{index}.jsonl"))),
    );
    current.and(previous).and(jsonl)
}

fn clear_previous_store(
    directory: &Path,
    names: impl IntoIterator<Item = impl AsRef<Path>>,
) -> io::Result<()> {
    match fs::symlink_metadata(directory) {
        Ok(_) => Store::new(directory)?.clear_files(names),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[derive(Default)]
struct RateLimit {
    last: HashMap<(Code, Status, String), Instant>,
    window: Option<Instant>,
    count: usize,
}

impl RateLimit {
    fn allow(&mut self, event: &Event, now: Instant) -> bool {
        if self
            .window
            .is_none_or(|start| now.duration_since(start) >= Duration::from_secs(60))
        {
            self.window = Some(now);
            self.count = 0;
            self.last
                .retain(|_, last| now.duration_since(*last) < Duration::from_secs(5));
        }
        if self.count >= 60 {
            return false;
        }
        if event.code.passive() {
            let invocation = event
                .command
                .as_ref()
                .map(|command| command.invocation.as_str());
            let key = (
                event.code,
                event.status,
                invocation.unwrap_or("").to_owned(),
            );
            if self
                .last
                .get(&key)
                .is_some_and(|last| now.duration_since(*last) < Duration::from_secs(5))
            {
                return false;
            }
            self.last.insert(key, now);
        }
        self.count += 1;
        true
    }
}

struct Store {
    directory: PathBuf,
    // The OS releases this cross-process lock even if the app crashes.
    _lock: File,
}

impl Store {
    fn new(directory: &Path) -> io::Result<Self> {
        if let Some(parent) = directory.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::create_dir(directory) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        if !fs::symlink_metadata(directory)?.file_type().is_dir() {
            return Err(invalid_store());
        }
        let directory = fs::canonicalize(directory)?;
        let lock_path = directory.join(".lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        safe_options(&mut options);
        let lock = options.open(lock_path)?;
        if !lock.metadata()?.is_file() {
            return Err(invalid_store());
        }
        lock.try_lock().map_err(|_| invalid_store())?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }

    fn summary(&self) -> io::Result<Summary> {
        let mut total_bytes = 0;
        let mut file_count = 0;
        for name in LOG_NAMES {
            if let Some(metadata) = self.metadata(name)? {
                total_bytes += metadata.len();
                file_count += 1;
            }
        }
        Ok(Summary {
            total_bytes,
            file_count,
            max_bytes: MAX_LOG_BYTES,
            retention_days: RETENTION_DAYS,
        })
    }

    fn clear_files(&self, names: impl IntoIterator<Item = impl AsRef<Path>>) -> io::Result<()> {
        let mut result = Ok(());
        for name in names {
            match fs::remove_file(self.directory.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => result = Err(error),
            }
        }
        result
    }

    fn metadata(&self, name: &str) -> io::Result<Option<fs::Metadata>> {
        match fs::symlink_metadata(self.directory.join(name)) {
            Ok(metadata) if metadata.file_type().is_file() => Ok(Some(metadata)),
            Ok(_) => Err(invalid_store()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn read(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        let Some(metadata) = self.metadata(name)? else {
            return Ok(None);
        };
        if metadata.len() > FILE_BYTES as u64 {
            return Err(invalid_store());
        }
        let file = open_log(&self.directory.join(name))?;
        let mut contents = Vec::new();
        file.take(FILE_BYTES as u64 + 1)
            .read_to_end(&mut contents)?;
        if contents.len() > FILE_BYTES {
            return Err(invalid_store());
        }
        Ok(Some(contents))
    }

    fn prune(&self, cutoff: u64) -> io::Result<()> {
        for name in LOG_NAMES {
            let Ok(Some(contents)) = self.read(name) else {
                continue;
            };
            let (retained, _) = sanitize(&contents, cutoff);
            let path = self.directory.join(name);
            if retained.is_empty() {
                fs::remove_file(path)?;
            } else if retained != contents {
                crate::fsutil::write_atomic(&path, &retained)?;
            }
        }
        Ok(())
    }

    fn append(&self, event: &Event) -> io::Result<()> {
        // Discard damaged oversized files before writing; do not grow the budget.
        for name in LOG_NAMES {
            if self
                .metadata(name)?
                .is_some_and(|metadata| metadata.len() > FILE_BYTES as u64)
            {
                fs::remove_file(self.directory.join(name))?;
            }
        }
        let directory = self.directory.to_str().ok_or_else(invalid_store)?;
        // The appender and roller interpolate these tokens in paths.
        if ["$ENV{", "$TIME{", "{}"]
            .iter()
            .any(|token| directory.contains(token))
        {
            return Err(invalid_store());
        }
        let path = self.directory.join(LOG_NAMES[0]);
        let (length, needs_newline) = prepare_active_log(&path)?;
        let mut line = event.line();
        if needs_newline {
            // Keep an interrupted write from swallowing the next complete record.
            line.insert(0, '\n');
        }
        if length + line.len() as u64 > FILE_BYTES as u64 {
            // The roller can fall back to copying if a rename fails.
            for name in &LOG_NAMES[1..] {
                if self.metadata(name)?.is_some() {
                    open_log(&self.directory.join(name))?;
                }
            }
            let pattern = self.directory.join("events.{}.log");
            FixedWindowRoller::builder()
                .base(1)
                .build(
                    pattern.to_str().ok_or_else(invalid_store)?,
                    (LOG_NAMES.len() - 1) as u32,
                )
                .and_then(|roller| roller.roll(&path))
                .map_err(|_| invalid_store())?;
            prepare_active_log(&path)?;
            line = event.line();
        }
        // Keep this appender private: only typed diagnostic events enter the file.
        FileAppender::builder()
            .append(true)
            .encoder(Box::new(PatternEncoder::new("{m}")))
            .build(&path)?
            .append(
                &Record::builder()
                    .level(event.status.level())
                    .args(format_args!("{line}"))
                    .build(),
            )
            .map_err(|_| invalid_store())
    }

    fn export(&self, destination: &Path) -> io::Result<ExportResult> {
        if !destination.is_absolute()
            || !destination
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        {
            return Err(invalid_store());
        }
        let parent = destination.parent().ok_or_else(invalid_store)?;
        let parent = fs::canonicalize(parent)?;
        if parent.starts_with(&self.directory) {
            return Err(invalid_store());
        }
        let destination = parent.join(destination.file_name().ok_or_else(invalid_store)?);
        let mut entries = Vec::new();
        let mut skipped_entries = 0;
        let cutoff = retention_cutoff();
        for name in LOG_NAMES {
            match self.read(name) {
                Ok(Some(contents)) => {
                    let (contents, skipped) = sanitize(&contents, cutoff);
                    skipped_entries += skipped;
                    if !contents.is_empty() {
                        entries.push((name, contents));
                    }
                }
                Ok(None) => {}
                Err(_) => skipped_entries += 1,
            }
        }
        let file_count = entries.len();
        let manifest = serde_json::json!({
            "schemaVersion": 4,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "logFiles": file_count,
            "skippedEntries": skipped_entries,
        });
        entries.push(("manifest.json", serde_json::to_vec_pretty(&manifest)?));
        entries.push(("README.txt", b"RebaseRaven local diagnostics\n\nEach line contains the local time and UTC offset, level, module, and message. Command entries include the command and selected options, outcome, and available exit status and output excerpts. Output can contain repository paths, server addresses, or other project details. Review this archive before sharing it.\n".to_vec()));
        let contents = archive::stored_zip(&entries)?;
        crate::fsutil::write_atomic(&destination, &contents)?;
        Ok(ExportResult {
            file_count,
            skipped_entries,
        })
    }
}

fn open_log(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    safe_options(&mut options);
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || !single_link(&file)? {
        return Err(invalid_store());
    }
    Ok(file)
}

fn prepare_active_log(path: &Path) -> io::Result<(u64, bool)> {
    let mut file = match open_log(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Set private permissions before handing the path to the appender.
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            safe_options(&mut options);
            options.open(path)?;
            return Ok((0, false));
        }
        Err(error) => return Err(error),
    };
    let length = file.metadata()?.len();
    if length == 0 {
        return Ok((0, false));
    }
    let mut last = [0];
    file.seek(SeekFrom::End(-1))?;
    file.read_exact(&mut last)?;
    Ok((length, last[0] != b'\n'))
}

#[cfg(unix)]
fn single_link(file: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink() == 1)
}

#[cfg(windows)]
fn single_link(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The open handle and the writable structure both outlive the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks == 1 && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0)
}

fn safe_options(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
}

fn invalid_store() -> io::Error {
    io::Error::other("Local diagnostics are unavailable.")
}

fn sanitize(contents: &[u8], cutoff: u64) -> (Vec<u8>, usize) {
    let mut output = Vec::new();
    let mut skipped = 0;
    for line in contents.split_inclusive(|byte| *byte == b'\n') {
        if line
            .strip_suffix(b"\n")
            .and_then(|line| Event::retained_line(line, cutoff))
            .is_some()
        {
            output.extend_from_slice(line);
        } else {
            skipped += 1;
        }
    }
    (output, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_removes_queued_and_rotated_logs_and_keeps_unmanaged_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("diagnostics-v3");
        let previous = temp.path().join("diagnostics-v2");
        let jsonl = temp.path().join("diagnostics-v1");
        for path in [&directory, &previous, &jsonl] {
            fs::create_dir(path).unwrap();
            fs::write(path.join("user-notes.log"), b"keep").unwrap();
        }
        let rolled = directory.join(LOG_NAMES[7]);
        let previous_log = previous.join(LOG_NAMES[0]);
        let jsonl_log = jsonl.join("events.31.jsonl");
        fs::write(&rolled, event().line()).unwrap();
        fs::write(&previous_log, event().line()).unwrap();
        fs::write(&jsonl_log, b"{}\n").unwrap();

        let (sender, receiver) = mpsc::sync_channel(4);
        let worker_path = directory.clone();
        let worker = std::thread::spawn(move || write_logs(&worker_path, receiver));
        sender.send(Work::Append(event())).unwrap();
        let (reply, response) = mpsc::channel();
        sender.send(Work::Clear(reply)).unwrap();
        response
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();

        let store = Store::new(&directory).unwrap();
        assert_eq!(store.summary().unwrap().file_count, 0);
        drop(store);
        assert!(!rolled.exists());
        assert!(!previous_log.exists());
        assert!(!jsonl_log.exists());
        for path in [&directory, &previous, &jsonl] {
            assert_eq!(fs::read(path.join("user-notes.log")).unwrap(), b"keep");
        }

        sender.send(Work::Append(event())).unwrap();
        drop(sender);
        worker.join().unwrap();
        assert_eq!(
            Store::new(&directory)
                .unwrap()
                .summary()
                .unwrap()
                .file_count,
            1
        );
    }

    fn event() -> Event {
        Event {
            time_unix_ms: unix_ms(),
            code: Code::UiReady,
            status: Status::Success,
            duration_ms: Some(42),
            reason: None,
            command: None,
        }
    }

    #[test]
    fn rotation_bounds_retained_logs_to_fifty_mebibytes() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let contents = vec![b'\n'; FILE_BYTES];
        for name in LOG_NAMES {
            fs::write(store.directory.join(name), &contents).unwrap();
        }
        let full = store.summary().unwrap();
        assert_eq!(full.max_bytes, 50 * 1024 * 1024);
        assert_eq!(full.total_bytes, full.max_bytes as u64);
        let entry = event();
        store.append(&entry).unwrap();
        let rotated = store.summary().unwrap();
        assert_eq!(rotated.file_count, LOG_NAMES.len());
        assert!(rotated.total_bytes <= rotated.max_bytes as u64);
        assert_eq!(
            store.read(LOG_NAMES[0]).unwrap().unwrap(),
            entry.line().as_bytes()
        );
    }

    #[test]
    fn export_filters_bad_headers_controls_and_incomplete_lines() {
        let valid = event().line();
        let contents = format!(
            "{valid}[2026-01-01 12:00:00.000 +08:00][DEBUG][Git] Unexpected level\n\
             [2026-01-01 12:00:00.000 +08:00][ERROR][Other] Unexpected module\n\
             [2026-01-01 12:00:00.000 +08:00][ERROR][P4] Invalid control: \x1b\n\
             incomplete"
        );
        let (sanitized, skipped) = sanitize(contents.as_bytes(), 0);
        assert_eq!(skipped, 4);
        assert_eq!(sanitized, valid.as_bytes());
        let mut invalid = event();
        invalid.time_unix_ms = MAX_TIMESTAMP_MS + 1;
        assert_eq!(sanitize(invalid.line().as_bytes(), 0).1, 1);
    }

    #[test]
    fn command_output_is_retained_in_the_exportable_store() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let ui = event().line();
        fs::write(store.directory.join(LOG_NAMES[1]), &ui).unwrap();
        let mut fetch = event();
        fetch.code = Code::GitFetch;
        fetch.status = Status::Failure;
        fetch.command = Some(CommandReport::new(
            fetch.code.category(),
            &["fetch", "--prune"],
            CommandOutput {
                stderr: b"remote: unavailable\r\n\ttry again later\n",
                stdout: b"first line\n\nlast line\n",
                status: None,
            },
        ));
        store.append(&fetch).unwrap();

        assert_eq!(store.read(LOG_NAMES[1]).unwrap().unwrap(), ui.as_bytes());
        let verbose = String::from_utf8(store.read(LOG_NAMES[0]).unwrap().unwrap()).unwrap();
        let output: Vec<_> = verbose
            .lines()
            .filter_map(|line| line.split_once("][VERBOSE][Commands] "))
            .map(|(_, body)| body)
            .collect();
        assert_eq!(
            output,
            [
                "stderr: remote: unavailable",
                "stderr: \ttry again later",
                "stdout: first line",
                "stdout: ",
                "stdout: last line",
            ]
        );
        let stored = store.read(LOG_NAMES[0]).unwrap().unwrap();
        assert_eq!(sanitize(&stored, 0), (stored, 0));
    }

    #[test]
    fn appending_after_an_interrupted_write_keeps_complete_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let first = event();
        let path = store.directory.join(LOG_NAMES[0]);
        fs::write(&path, format!("{}interrupted", first.line())).unwrap();
        let mut reader = File::open(&path).unwrap();
        let mut second = event();
        second.code = Code::PerforceResolve;
        second.status = Status::Failure;
        second.reason = Some("Automatic merge left conflicts".to_owned());

        store.append(&second).unwrap();

        let mut contents = Vec::new();
        reader.read_to_end(&mut contents).unwrap();
        let (retained, skipped) = sanitize(&contents, 0);
        assert_eq!(skipped, 1);
        assert_eq!(
            retained,
            format!("{}{}", first.line(), second.line()).as_bytes()
        );
        assert!(second
            .line()
            .contains("][ERROR][P4] Verify conflict resolution: Failed in 42 ms"));
    }

    #[test]
    fn append_and_rotation_do_not_follow_hard_links() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let target = temp.path().join("existing.txt");
        fs::write(&target, b"unchanged").unwrap();
        let active = store.directory.join(LOG_NAMES[0]);
        fs::hard_link(&target, &active).unwrap();
        assert!(store.append(&event()).is_err());
        fs::remove_file(&active).unwrap();

        fs::write(active, vec![b'\n'; FILE_BYTES]).unwrap();
        fs::hard_link(&target, store.directory.join(LOG_NAMES[1])).unwrap();
        assert!(store.append(&event()).is_err());
        assert_eq!(fs::read(target).unwrap(), b"unchanged");
    }

    #[test]
    fn retention_prunes_expired_entries_from_active_and_rotated_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let mut expired = event();
        expired.time_unix_ms = 1;
        store.append(&expired).unwrap();
        fs::write(store.directory.join(LOG_NAMES[1]), expired.line()).unwrap();
        let mut recent = event();
        recent.code = Code::PerforceSync;
        store.append(&recent).unwrap();

        store.prune(retention_cutoff()).unwrap();

        assert!(store.read(LOG_NAMES[1]).unwrap().is_none());
        let retained = store.read(LOG_NAMES[0]).unwrap().unwrap();
        assert_eq!(retained, recent.line().as_bytes());
    }

    #[test]
    fn rotation_keeps_logs_within_the_total_budget() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let line = event().line();
        let full = line.as_bytes().repeat(FILE_BYTES / line.len());
        for name in LOG_NAMES {
            fs::write(store.directory.join(name), &full).unwrap();
        }
        store.append(&event()).unwrap();
        let summary = store.summary().unwrap();
        assert_eq!(summary.file_count, LOG_NAMES.len());
        assert_eq!(summary.max_bytes, 50 * 1024 * 1024);
        assert!(summary.total_bytes <= summary.max_bytes as u64);
        assert!(store.read(LOG_NAMES[0]).unwrap().unwrap().len() < 1024);
        assert_eq!(store.read(LOG_NAMES[1]).unwrap().unwrap(), full);
        fs::write(store.directory.join(LOG_NAMES[2]), vec![0; FILE_BYTES + 1]).unwrap();
        store.append(&event()).unwrap();
        assert!(store.summary().unwrap().total_bytes <= summary.max_bytes as u64);
    }

    #[test]
    fn export_does_not_include_unmanaged_files_or_write_inside_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        store.append(&event()).unwrap();
        fs::write(store.directory.join("prefs.json"), b"private-value").unwrap();
        assert!(store.export(&store.directory.join("out.zip")).is_err());
        assert!(store.export(Path::new("relative.zip")).is_err());
        let output = temp.path().join("out.zip");
        let result = store.export(&output).unwrap();
        assert_eq!(result.file_count, 1);
        assert_eq!(result.skipped_entries, 0);
        let archive = fs::read(output).unwrap();
        assert!(archive
            .windows(b"events.log".len())
            .any(|value| value == b"events.log"));
        assert!(!archive
            .windows(b"private-value".len())
            .any(|value| value == b"private-value"));
        assert!(archive.len() <= archive::MAX_ARCHIVE_BYTES);
    }

    #[test]
    fn simultaneous_store_handles_cannot_rotate_the_same_logs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("logs");
        let first = Store::new(&path).unwrap();
        assert!(Store::new(&path).is_err());
        drop(first);
        assert!(Store::new(&path).is_ok());
    }

    #[test]
    fn repetitive_events_are_throttled_but_new_statuses_are_distinct() {
        let mut limit = RateLimit::default();
        let now = Instant::now();
        let mut read = event();
        read.code = Code::GitStatus;
        assert!(limit.allow(&read, now));
        assert!(!limit.allow(&read, now + Duration::from_secs(1)));
        read.status = Status::Failure;
        assert!(limit.allow(&read, now + Duration::from_secs(1)));
        read.status = Status::Success;
        assert!(limit.allow(&read, now + Duration::from_secs(5)));

        read.code = Code::GitFetch;
        assert!(limit.allow(&read, now + Duration::from_secs(5)));
        assert!(limit.allow(&read, now + Duration::from_secs(5)));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directories_and_entries_are_not_followed() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let other = temp.path().join("other");
        fs::create_dir(&other).unwrap();
        let linked = temp.path().join("linked");
        symlink(&other, &linked).unwrap();
        assert!(Store::new(&linked).is_err());
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let private = other.join("secret");
        fs::write(&private, b"private-value").unwrap();
        symlink(&private, store.directory.join(LOG_NAMES[0])).unwrap();
        assert!(store.append(&event()).is_err());
        assert!(store.read(LOG_NAMES[0]).is_err());
        let result = store.export(&temp.path().join("out.zip")).unwrap();
        assert_eq!(result.skipped_entries, 1);
        assert_eq!(fs::read(&private).unwrap(), b"private-value");
    }
}
