mod archive;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const FILE_BYTES: usize = 262_144;
const LOG_NAMES: [&str; 4] = [
    "events.jsonl",
    "events.1.jsonl",
    "events.2.jsonl",
    "events.3.jsonl",
];
const MAX_DURATION_MS: u64 = 86_400_000;
const MAX_TIMESTAMP_MS: u64 = 4_102_444_800_000;
const ISSUES_URL: &str = "https://github.com/FlyAndNotDown/Rebasely/issues";
static EVENTS: OnceLock<mpsc::SyncSender<Event>> = OnceLock::new();

/// Only fixed diagnostic categories cross this boundary. Never add user input.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    AppStarted,
    UiReady,
    UpdateCheck,
    UpdateDownload,
    UpdateInstall,
    UpdateRestart,
    GitOperation,
    PerforceOperation,
    CredentialRequest,
    DiagnosticsExport,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    schema_version: u8,
    time_unix_ms: u64,
    code: Code,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    total_bytes: u64,
    file_count: usize,
    max_bytes: usize,
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
    let (sender, receiver) = mpsc::sync_channel::<Event>(64);
    std::thread::Builder::new()
        .name("local-diagnostics".into())
        .spawn(move || {
            let mut limiter = RateLimit::default();
            for event in receiver {
                if limiter.allow(event.code, event.status, Instant::now()) {
                    let _ = Store::new(&directory).and_then(|store| store.append(&event));
                }
            }
        })
        .map_err(|_| AppError::msg("Could not start local diagnostics."))?;
    let _ = EVENTS.set(sender);
    record(Code::AppStarted, Status::Success, None);
    Ok(())
}

/// Successful fast reads stay quiet; failures and slow operations carry no input data.
pub fn record_slow_or_failed<T>(code: Code, started: Instant, result: &AppResult<T>) {
    let elapsed = started.elapsed();
    let status = match result {
        Ok(_) if elapsed < Duration::from_secs(1) => return,
        Ok(_) => Status::Success,
        Err(error) if error.is_cancelled() => Status::Cancelled,
        Err(_) => Status::Failure,
    };
    record(code, status, Some(elapsed));
}

/// Nonblocking and deliberately unable to accept paths, messages, or command output.
pub fn record(code: Code, status: Status, duration: Option<Duration>) {
    if let Some(sender) = EVENTS.get() {
        let _ = sender.try_send(Event {
            schema_version: 1,
            time_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(MAX_TIMESTAMP_MS)) as u64,
            code,
            status,
            duration_ms: duration
                .map(|value| value.as_millis().min(u128::from(MAX_DURATION_MS)) as u64),
        });
    }
}

pub fn summary(app: &AppHandle) -> AppResult<Summary> {
    let directory = log_directory(app)?;
    Store::new(&directory)
        .and_then(|store| store.summary())
        .map_err(|_| AppError::msg("Could not read local diagnostics. Try again."))
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
        .map(|directory| directory.join("diagnostics-v1"))
        .map_err(|_| AppError::msg("The local diagnostics folder is unavailable."))
}

#[derive(Default)]
struct RateLimit {
    last: HashMap<(Code, Status), Instant>,
    window: Option<Instant>,
    count: usize,
}

impl RateLimit {
    fn allow(&mut self, code: Code, status: Status, now: Instant) -> bool {
        if self
            .window
            .is_none_or(|start| now.duration_since(start) >= Duration::from_secs(60))
        {
            self.window = Some(now);
            self.count = 0;
        }
        if self.count >= 60
            || self
                .last
                .get(&(code, status))
                .is_some_and(|last| now.duration_since(*last) < Duration::from_secs(5))
        {
            return false;
        }
        self.count += 1;
        self.last.insert((code, status), now);
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
            max_bytes: FILE_BYTES * LOG_NAMES.len(),
        })
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
        let mut options = OpenOptions::new();
        options.read(true);
        safe_options(&mut options);
        let file = options.open(self.directory.join(name))?;
        if !file.metadata()?.is_file() {
            return Err(invalid_store());
        }
        let mut contents = Vec::new();
        file.take(FILE_BYTES as u64 + 1)
            .read_to_end(&mut contents)?;
        if contents.len() > FILE_BYTES {
            return Err(invalid_store());
        }
        Ok(Some(contents))
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
        let mut line = serde_json::to_vec(event)?;
        line.push(b'\n');
        let mut contents = self.read(LOG_NAMES[0])?.unwrap_or_default();
        if contents.len() + line.len() > FILE_BYTES {
            for index in (1..LOG_NAMES.len()).rev() {
                if let Some(previous) = self.read(LOG_NAMES[index - 1])? {
                    crate::fsutil::write_atomic(&self.directory.join(LOG_NAMES[index]), &previous)?;
                }
            }
            contents.clear();
        }
        contents.extend_from_slice(&line);
        crate::fsutil::write_atomic(&self.directory.join(LOG_NAMES[0]), &contents)
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
        for name in LOG_NAMES {
            match self.read(name) {
                Ok(Some(contents)) => {
                    let (contents, skipped) = sanitize(&contents);
                    skipped_entries += skipped;
                    entries.push((name, contents));
                }
                Ok(None) => {}
                Err(_) => skipped_entries += 1,
            }
        }
        let file_count = entries.len();
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "logFiles": file_count,
            "skippedEntries": skipped_entries,
        });
        entries.push(("manifest.json", serde_json::to_vec_pretty(&manifest)?));
        entries.push(("README.txt", b"Rebasely local diagnostics\n\nThis archive contains fixed diagnostic codes, timestamps, durations, app version, and platform only. No repository paths, remote URLs, usernames, credentials, command output, or original error messages are collected. Nothing is uploaded automatically. Review the archive before sharing it manually in an issue.\n".to_vec()));
        let contents = archive::stored_zip(&entries)?;
        crate::fsutil::write_atomic(&destination, &contents)?;
        Ok(ExportResult {
            file_count,
            skipped_entries,
        })
    }
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

fn sanitize(contents: &[u8]) -> (Vec<u8>, usize) {
    let mut output = Vec::new();
    let mut skipped = 0;
    for line in contents
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let event = if line.len() <= 1024 {
            serde_json::from_slice::<Event>(line).ok()
        } else {
            None
        };
        let Some(event) = event.filter(|event| {
            event.schema_version == 1
                && event.time_unix_ms <= MAX_TIMESTAMP_MS
                && event
                    .duration_ms
                    .is_none_or(|duration| duration <= MAX_DURATION_MS)
        }) else {
            skipped += 1;
            continue;
        };
        if let Ok(mut line) = serde_json::to_vec(&event) {
            line.push(b'\n');
            if output.len() + line.len() <= FILE_BYTES {
                output.extend_from_slice(&line);
            } else {
                skipped += 1;
            }
        }
    }
    (output, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> Event {
        Event {
            schema_version: 1,
            time_unix_ms: 1,
            code: Code::UiReady,
            status: Status::Success,
            duration_ms: Some(42),
        }
    }

    #[test]
    fn exported_records_reject_extra_fields_unknown_codes_and_invalid_limits() {
        let valid = serde_json::to_string(&event()).unwrap();
        let contents = format!("{valid}\n{{\"schemaVersion\":1,\"timeUnixMs\":1,\"code\":\"uiReady\",\"status\":\"success\",\"path\":\"/private/example\"}}\n{{\"schemaVersion\":1,\"timeUnixMs\":1,\"code\":\"https://example.com\",\"status\":\"failure\"}}\nnot json\n");
        let (sanitized, skipped) = sanitize(contents.as_bytes());
        assert_eq!(skipped, 3);
        assert_eq!(String::from_utf8(sanitized).unwrap(), format!("{valid}\n"));
        let mut invalid = event();
        invalid.duration_ms = Some(MAX_DURATION_MS + 1);
        assert_eq!(sanitize(&serde_json::to_vec(&invalid).unwrap()).1, 1);
        invalid.duration_ms = None;
        invalid.schema_version = 2;
        assert_eq!(sanitize(&serde_json::to_vec(&invalid).unwrap()).1, 1);
    }

    #[test]
    fn rotation_keeps_four_files_within_the_total_budget() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let line = serde_json::to_vec(&event()).unwrap();
        let mut full = Vec::new();
        while full.len() + line.len() < FILE_BYTES {
            full.extend_from_slice(&line);
            full.push(b'\n');
        }
        for name in LOG_NAMES {
            fs::write(store.directory.join(name), &full).unwrap();
        }
        store.append(&event()).unwrap();
        let summary = store.summary().unwrap();
        assert_eq!(summary.file_count, 4);
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
        assert!(limit.allow(Code::GitOperation, Status::Success, now));
        assert!(!limit.allow(
            Code::GitOperation,
            Status::Success,
            now + Duration::from_secs(1)
        ));
        assert!(limit.allow(
            Code::GitOperation,
            Status::Failure,
            now + Duration::from_secs(1)
        ));
        assert!(limit.allow(
            Code::GitOperation,
            Status::Success,
            now + Duration::from_secs(5)
        ));
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
