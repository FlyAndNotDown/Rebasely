use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterBuilder, UpdaterExt};

use crate::diagnostics::{self, Code, Status};
use crate::error::{redact_credentials, AppError, AppResult};
use crate::network::HttpPolicy;

const UPDATE_ENDPOINT: &str =
    "https://github.com/FlyAndNotDown/Rebasely/releases/latest/download/latest.json";
const UPDATE_EVENT: &str = "app-update";
const MAX_VERSION_BYTES: usize = 128;
const MAX_NOTES_BYTES: usize = 16 * 1024;
const MAX_ERROR_BYTES: usize = 2048;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Installing,
    Installed,
    Error,
}

impl UpdateStatus {
    fn busy(self) -> bool {
        matches!(self, Self::Checking | Self::Downloading | Self::Installing)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub revision: u64,
    pub status: UpdateStatus,
    pub update: Option<UpdateInfo>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    snapshot: UpdateState,
    // Only an update checked by the native plugin can be installed. The webview
    // cannot provide a download URL, signature, public key, or installer bytes.
    pending: Option<PendingUpdate>,
}

#[derive(Clone)]
struct PendingUpdate {
    update: Update,
    routing: Arc<Mutex<HttpPolicy>>,
}

fn configure_routing(builder: UpdaterBuilder, routing: Arc<Mutex<HttpPolicy>>) -> UpdaterBuilder {
    builder.configure_client(move |builder| {
        routing
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .apply(builder)
    })
}

impl Inner {
    fn begin_check(&mut self) -> bool {
        if self.snapshot.status.busy() || self.snapshot.status == UpdateStatus::Installed {
            return false;
        }
        self.snapshot.status = UpdateStatus::Checking;
        self.snapshot.error = None;
        self.snapshot.downloaded_bytes = 0;
        self.snapshot.total_bytes = None;
        true
    }
}

#[derive(Default)]
pub struct UpdateManager(Mutex<Inner>);

impl UpdateManager {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn snapshot(&self) -> UpdateState {
        self.lock().snapshot.clone()
    }

    fn publish(app: &AppHandle, inner: &mut Inner) -> UpdateState {
        inner.snapshot.revision = inner.snapshot.revision.saturating_add(1);
        let snapshot = inner.snapshot.clone();
        let _ = app.emit(UPDATE_EVENT, &snapshot);
        snapshot
    }

    fn fail(&self, app: &AppHandle, message: &str) -> UpdateState {
        let mut inner = self.lock();
        inner.snapshot.status = UpdateStatus::Error;
        inner.snapshot.error = Some(bounded_text(&redact_credentials(message), MAX_ERROR_BYTES));
        Self::publish(app, &mut inner)
    }
}

fn bounded_text(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}

fn release_download_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .starts_with("/FlyAndNotDown/Rebasely/releases/download/")
        && url
            .path_segments()
            .is_some_and(|segments| segments.count() >= 6)
}

fn update_info(update: &Update) -> AppResult<UpdateInfo> {
    if update.version.len() > MAX_VERSION_BYTES
        || update.current_version.len() > MAX_VERSION_BYTES
        || !release_download_url(&update.download_url)
        || update.signature.is_empty()
    {
        return Err(AppError::msg(
            "The release contains invalid update information. Check the GitHub release and try again.",
        ));
    }
    Ok(UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update
            .body
            .as_deref()
            .map(|notes| bounded_text(notes, MAX_NOTES_BYTES)),
        published_at: update
            .raw_json
            .get("pub_date")
            .and_then(serde_json::Value::as_str)
            .map(|date| bounded_text(date, 128)),
    })
}

fn validate_install(snapshot: &UpdateState, version: &str, has_pending: bool) -> AppResult<()> {
    if snapshot.status.busy() {
        return Err(AppError::msg("An update operation is already in progress."));
    }
    if snapshot.status == UpdateStatus::Installed {
        return Err(AppError::msg(
            "The update is already installed. Restart Rebasely to use it.",
        ));
    }
    if version.len() > MAX_VERSION_BYTES
        || !has_pending
        || snapshot
            .update
            .as_ref()
            .map(|update| update.version.as_str())
            != Some(version)
    {
        return Err(AppError::msg(
            "This update is no longer available. Check for updates again.",
        ));
    }
    Ok(())
}

fn check_error(error: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::ReleaseNotFound => "No public update release is available yet. Retry after a release has been published on GitHub.".to_string(),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "The latest release has no update package for this platform. Check the GitHub release for a compatible download.".to_string(),
        Error::Reqwest(error) if error.status().is_some_and(|status| status.as_u16() == 404) => "No public update release is available yet. Retry after a release has been published on GitHub.".to_string(),
        _ => operation_error("Could not check for updates. Check your connection and retry.", error),
    }
}

fn operation_error(context: &str, error: &impl std::fmt::Display) -> String {
    format!(
        "{context} {}",
        bounded_text(&redact_credentials(&error.to_string()), MAX_ERROR_BYTES / 2)
    )
}

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> UpdateState {
    app.state::<UpdateManager>().snapshot()
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> UpdateState {
    let manager = app.state::<UpdateManager>();
    {
        let mut inner = manager.lock();
        if !inner.begin_check() {
            return inner.snapshot.clone();
        }
        UpdateManager::publish(&app, &mut inner);
    }
    let started = Instant::now();
    let result = async {
        let prefs_app = app.clone();
        let preferences = crate::blocking(move || crate::prefs::load_prefs(&prefs_app))
            .await
            .map_err(|error| error.to_string())?;
        let routing = Arc::new(Mutex::new(
            crate::network::policy_from_preferences(&preferences)
                .map_err(|error| error.to_string())?,
        ));
        let updater = app
            .updater_builder()
            .endpoints(vec![
                url::Url::parse(UPDATE_ENDPOINT).expect("valid release endpoint")
            ])
            .map_err(|error| check_error(&error))?
            .timeout(Duration::from_secs(25));
        let updater = configure_routing(updater, routing.clone())
            .build()
            .map_err(|error| check_error(&error))?;
        let mut update = updater.check().await.map_err(|error| check_error(&error))?;
        let info = update
            .as_ref()
            .map(update_info)
            .transpose()
            .map_err(|error| error.to_string())?;
        if let Some(update) = update.as_mut() {
            update.timeout = Some(Duration::from_secs(15 * 60));
            update.body = info.as_ref().and_then(|info| info.notes.clone());
            // Installation needs the selected URL and signature, not the
            // manifest's other platforms or arbitrary extra response fields.
            update.raw_json = serde_json::Value::Null;
        }
        Ok::<_, String>((update.map(|update| PendingUpdate { update, routing }), info))
    }
    .await;
    match result {
        Ok((update, info)) => {
            diagnostics::record(Code::UpdateCheck, Status::Success, Some(started.elapsed()));
            let mut inner = manager.lock();
            inner.pending = update;
            inner.snapshot.status = if info.is_some() {
                UpdateStatus::Available
            } else {
                UpdateStatus::Current
            };
            inner.snapshot.update = info;
            UpdateManager::publish(&app, &mut inner)
        }
        Err(message) => {
            diagnostics::record(Code::UpdateCheck, Status::Failure, Some(started.elapsed()));
            manager.fail(&app, &message)
        }
    }
}

#[tauri::command]
pub async fn install_update(version: String, app: AppHandle) -> AppResult<UpdateState> {
    let manager = app.state::<UpdateManager>();
    let pending = {
        let mut inner = manager.lock();
        validate_install(&inner.snapshot, &version, inner.pending.is_some())?;
        let pending = inner
            .pending
            .as_ref()
            .expect("validated pending update")
            .clone();
        inner.snapshot.status = UpdateStatus::Downloading;
        inner.snapshot.error = None;
        inner.snapshot.downloaded_bytes = 0;
        inner.snapshot.total_bytes = None;
        UpdateManager::publish(&app, &mut inner);
        pending
    };
    let download_started = Instant::now();
    // A proxy corrected in Settings also applies to a retry of an already checked update.
    let prefs_app = app.clone();
    let routing = crate::blocking(move || crate::prefs::load_prefs(&prefs_app))
        .await
        .and_then(|prefs| crate::network::policy_from_preferences(&prefs));
    match routing {
        Ok(routing) => {
            *pending
                .routing
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = routing
        }
        Err(error) => {
            diagnostics::record(
                Code::UpdateDownload,
                Status::Failure,
                Some(download_started.elapsed()),
            );
            return Ok(manager.fail(&app, &error.to_string()));
        }
    }
    // Windows installation closes the app; the explicit Update action starts it.
    let update = pending.update.restart_after_install(false);
    let mut last_progress = Instant::now();
    let download = update
        .download(
            |chunk, total| {
                let mut inner = manager.lock();
                inner.snapshot.downloaded_bytes =
                    inner.snapshot.downloaded_bytes.saturating_add(chunk as u64);
                inner.snapshot.total_bytes = total;
                if last_progress.elapsed() >= Duration::from_millis(100) {
                    UpdateManager::publish(&app, &mut inner);
                    last_progress = Instant::now();
                }
            },
            || {},
        )
        .await;
    let bytes = match download {
        Ok(bytes) => bytes,
        Err(error) => {
            diagnostics::record(
                Code::UpdateDownload,
                Status::Failure,
                Some(download_started.elapsed()),
            );
            let message = operation_error(
                "Could not download or verify the update. Retry the installation or check for updates again.",
                &error,
            );
            return Ok(manager.fail(&app, &message));
        }
    };
    diagnostics::record(
        Code::UpdateDownload,
        Status::Success,
        Some(download_started.elapsed()),
    );
    {
        let mut inner = manager.lock();
        inner.snapshot.status = UpdateStatus::Installing;
        UpdateManager::publish(&app, &mut inner);
    }
    let install_started = Instant::now();
    let result = crate::blocking(move || {
        update
            .install(bytes)
            .map_err(|error| AppError::msg(error.to_string()))
    })
    .await;
    match result {
        Ok(()) => {
            diagnostics::record(
                Code::UpdateInstall,
                Status::Success,
                Some(install_started.elapsed()),
            );
            let mut inner = manager.lock();
            inner.pending = None;
            inner.snapshot.status = UpdateStatus::Installed;
            Ok(UpdateManager::publish(&app, &mut inner))
        }
        Err(error) => {
            diagnostics::record(
                Code::UpdateInstall,
                Status::Failure,
                Some(install_started.elapsed()),
            );
            Ok(manager.fail(&app, &operation_error(
                "Could not install the update. Retry the installation or download the release from GitHub.", &error,
            )))
        }
    }
}

#[tauri::command]
pub fn restart_after_update(app: AppHandle) -> AppResult<()> {
    if app.state::<UpdateManager>().snapshot().status != UpdateStatus::Installed {
        return Err(AppError::msg(
            "Install the update before restarting Rebasely.",
        ));
    }
    diagnostics::record(Code::UpdateRestart, Status::Success, None);
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> UpdateState {
        UpdateState {
            status: UpdateStatus::Available,
            update: Some(UpdateInfo {
                version: "0.0.2".to_string(),
                current_version: "0.0.1".to_string(),
                notes: None,
                published_at: None,
            }),
            ..UpdateState::default()
        }
    }

    #[test]
    fn only_public_release_downloads_from_this_repository_are_accepted() {
        let valid = "https://github.com/FlyAndNotDown/Rebasely/releases/download/v0.0.2/update.exe";
        assert!(release_download_url(&url::Url::parse(valid).unwrap()));
        for invalid in [
            "http://github.com/FlyAndNotDown/Rebasely/releases/download/v0.0.2/update.exe",
            "https://example.com/FlyAndNotDown/Rebasely/releases/download/v0.0.2/update.exe",
            "https://github.com/other/repo/releases/download/v0.0.2/update.exe",
            "https://github.com/FlyAndNotDown/Rebasely/releases/latest/download/update.exe",
            "https://alice:secret@github.com/FlyAndNotDown/Rebasely/releases/download/v0.0.2/update.exe",
            "https://github.com/FlyAndNotDown/Rebasely/releases/download/v0.0.2/update.exe?token=secret",
        ] {
            assert!(!release_download_url(&url::Url::parse(invalid).unwrap()));
        }
    }

    #[test]
    fn installation_requires_the_checked_version_and_rejects_duplicate_mutations() {
        let mut snapshot = available();
        assert!(validate_install(&snapshot, "0.0.2", true).is_ok());
        assert!(validate_install(&snapshot, "0.0.3", true).is_err());
        assert!(validate_install(&snapshot, "0.0.2", false).is_err());
        for status in [
            UpdateStatus::Checking,
            UpdateStatus::Downloading,
            UpdateStatus::Installing,
            UpdateStatus::Installed,
        ] {
            snapshot.status = status;
            assert!(validate_install(&snapshot, "0.0.2", true).is_err());
        }
        snapshot.status = UpdateStatus::Error;
        assert!(validate_install(&snapshot, "0.0.2", true).is_ok());
    }

    #[test]
    fn overlapping_checks_and_checks_after_install_do_not_start_another_request() {
        let mut inner = Inner::default();
        assert!(inner.begin_check());
        assert!(!inner.begin_check());
        for status in [
            UpdateStatus::Downloading,
            UpdateStatus::Installing,
            UpdateStatus::Installed,
        ] {
            inner.snapshot.status = status;
            assert!(!inner.begin_check());
        }
        inner.snapshot.status = UpdateStatus::Error;
        assert!(inner.begin_check());
    }

    #[test]
    fn bounded_release_text_preserves_utf8_and_plain_small_text() {
        assert_eq!(bounded_text("Release notes", 30), "Release notes");
        let bounded = bounded_text(&"\u{1f680}".repeat(100), 128);
        assert!(bounded.len() <= 128);
        assert!(bounded.ends_with("..."));
    }

    #[test]
    fn update_state_uses_the_shared_camel_case_command_contract() {
        let state = serde_json::to_value(available()).unwrap();
        assert_eq!(state["revision"], 0);
        assert_eq!(state["status"], "available");
        assert_eq!(state["update"]["currentVersion"], "0.0.1");
        assert!(state["update"]["publishedAt"].is_null());
        assert!(state["totalBytes"].is_null());
        assert_eq!(state["downloadedBytes"], 0);
    }

    #[test]
    fn native_update_check_and_retry_use_the_selected_http_route() {
        use crate::network::tests::HttpFixture;
        use crate::network::{HttpProxy, ProxyMode};
        use crate::prefs::AppPrefs;

        tauri::async_runtime::block_on(async {
            let manifest = serde_json::json!({
                "version": "9.9.9",
                "notes": "Fixture update",
                "platforms": {
                    "fixture-target": {
                        "url": "https://github.com/FlyAndNotDown/Rebasely/releases/download/v9.9.9/fixture.tar.gz",
                        "signature": "not-a-real-signature"
                    }
                }
            }).to_string();
            let check_proxy = HttpFixture::new(&manifest);
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().plugins.0.insert(
                "updater".to_string(),
                serde_json::json!({
                    "dangerousInsecureTransportProtocol": true,
                    "pubkey": "not-a-real-key"
                }),
            );
            let app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let preferences = AppPrefs {
                http_proxy: HttpProxy {
                    mode: ProxyMode::Manual,
                    url: check_proxy.url.clone(),
                },
                ..AppPrefs::default()
            };
            let routing = Arc::new(Mutex::new(
                crate::network::policy_from_preferences(&preferences).unwrap(),
            ));
            let builder = app
                .updater_builder()
                .target("fixture-target")
                .executable_path(std::env::temp_dir().join("rebasely-fixture-app"))
                .timeout(Duration::from_secs(3))
                .endpoints(vec![url::Url::parse(
                    "http://release.example.test/latest.json",
                )
                .unwrap()])
                .unwrap();
            let updater = configure_routing(builder, routing.clone()).build().unwrap();
            let mut update = updater.check().await.unwrap().unwrap();
            assert_eq!(update_info(&update).unwrap().version, "9.9.9");
            assert_eq!(
                check_proxy.request(),
                "GET http://release.example.test/latest.json HTTP/1.1"
            );

            // A retry of the checked update must use a newly saved proxy, not its old route.
            let download_proxy = HttpFixture::new("unsigned fixture bytes");
            let preferences = AppPrefs {
                http_proxy: HttpProxy {
                    mode: ProxyMode::Manual,
                    url: download_proxy.url.clone(),
                },
                ..AppPrefs::default()
            };
            *routing.lock().unwrap() =
                crate::network::policy_from_preferences(&preferences).unwrap();
            update.download_url =
                url::Url::parse("http://artifact.example.test/fixture.tar.gz").unwrap();
            assert!(update.download(|_, _| {}, || {}).await.is_err());
            assert_eq!(
                download_proxy.request(),
                "GET http://artifact.example.test/fixture.tar.gz HTTP/1.1"
            );
            // Deliberately invalid fixture signatures are rejected; installation is never invoked.
        });
    }
}
