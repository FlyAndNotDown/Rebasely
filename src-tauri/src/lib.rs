mod askpass;
mod editor;
mod error;
mod fsutil;
mod git;
mod prefs;
mod recents;
mod session;
mod terminal;
mod watch;
mod window_state;

use std::path::Path;

use serde::Serialize;
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager, State};

const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

use error::{AppError, AppResult};
use git::{
    BlameHunk, BranchList, CommitDetails, CommitFile, CommitSummary, DirEntry, FileDiff, FileText,
    GitIdentity, RebaseCommit,
    RebaseStep, RemoteProbe, StashDetails, WorkspaceSnapshot,
};
use prefs::AppPrefs;
use recents::RecentRepo;
use session::AppSession;
use terminal::TerminalOption;
use watch::WatchState;

fn with_repo<T>(path: &str, f: impl FnOnce(&mut git2::Repository) -> AppResult<T>) -> AppResult<T> {
    let path = git::strip_verbatim_prefix(path);
    let mut repo = git::open_at(Path::new(&path))?;
    f(&mut repo)
}

/// Synchronous commands run on the main thread, so anything that touches the
/// disk or spawns processes goes through here instead.
async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|err| AppError::msg(err.to_string()))?
}

async fn with_repo_async<T, F>(path: String, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut git2::Repository) -> AppResult<T> + Send + 'static,
{
    blocking(move || with_repo(&path, f)).await
}

#[tauri::command]
async fn list_recents(app: AppHandle) -> AppResult<Vec<RecentRepo>> {
    blocking(move || recents::load_recents(&app)).await
}

#[tauri::command]
async fn forget_recent(path: String, app: AppHandle) -> AppResult<Vec<RecentRepo>> {
    blocking(move || recents::forget_repo(&app, &path)).await
}

#[tauri::command]
async fn load_session(app: AppHandle) -> AppResult<AppSession> {
    blocking(move || session::load_session(&app)).await
}

// Kept synchronous so rapid saves land in the order they were sent.
#[tauri::command]
fn save_session(session: AppSession, app: AppHandle) -> AppResult<AppSession> {
    session::save_session(&app, session)
}

#[tauri::command]
async fn clone_repository(
    url: String,
    destination: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<String> {
    blocking(move || {
        git::with_cancel(activity_id.as_deref(), || {
            git::clone_repository(&url, &destination, progress_sink(&app, activity_id.as_deref()))
        })
    })
    .await
}

#[tauri::command]
fn cancel_activity(id: String) -> bool {
    git::cancel_activity(&id)
}

#[tauri::command]
fn answer_askpass(id: u64, answer: Option<String>) -> AppResult<()> {
    askpass::answer(id, answer)
}

/// Runs the askpass helper mode when git or ssh launched this executable for a
/// credential prompt.
pub fn askpass_client() -> Option<i32> {
    askpass::run_client()
}

#[tauri::command]
async fn open_repository(path: String, app: AppHandle) -> AppResult<WorkspaceSnapshot> {
    blocking(move || {
        let mut repo = git::discover(&path)?;
        let snapshot = git::snapshot(&mut repo)?;
        recents::remember_repo(&app, &snapshot.repo.path, &snapshot.repo.name)?;
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
async fn refresh_workspace(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::snapshot).await
}

#[tauri::command]
async fn get_commits(
    repo_path: String,
    limit: Option<usize>,
    skip: Option<usize>,
    query: Option<String>,
    rev: Option<Vec<String>>,
) -> AppResult<Vec<CommitSummary>> {
    with_repo_async(repo_path, move |repo| {
        git::commits(
            repo,
            limit.unwrap_or(80),
            skip.unwrap_or(0),
            query.as_deref(),
            rev.as_deref().unwrap_or(&[]),
        )
    })
    .await
}

#[tauri::command]
async fn get_branches(repo_path: String) -> AppResult<BranchList> {
    with_repo_async(repo_path, move |repo| git::branches(repo, true)).await
}

#[tauri::command]
async fn get_workdir_diff(
    repo_path: String,
    path: String,
    staged: bool,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::workdir_diff(repo, &path, staged, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn list_directory(repo_path: String, path: String) -> AppResult<Vec<DirEntry>> {
    with_repo_async(repo_path, move |repo| git::list_directory(repo, &path)).await
}

#[tauri::command]
async fn read_file(repo_path: String, path: String) -> AppResult<FileText> {
    with_repo_async(repo_path, move |repo| git::read_file(repo, &path)).await
}

#[tauri::command]
async fn file_blame(repo_path: String, path: String) -> AppResult<Vec<BlameHunk>> {
    with_repo_async(repo_path, move |repo| git::file_blame(repo, &path)).await
}

#[tauri::command]
async fn file_commits(
    repo_path: String,
    path: String,
    limit: usize,
    skip: usize,
) -> AppResult<Vec<CommitSummary>> {
    with_repo_async(repo_path, move |repo| git::file_commits(repo, &path, limit, skip)).await
}

#[tauri::command]
async fn get_commit_details(repo_path: String, oid: String) -> AppResult<CommitDetails> {
    with_repo_async(repo_path, move |repo| git::commit_details(repo, &oid)).await
}

#[tauri::command]
async fn get_commit_diff(
    repo_path: String,
    oid: String,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::commit_file_diff(repo, &oid, &path, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn get_image_pair(repo_path: String, source: git::FileSource) -> AppResult<git::ImagePair> {
    with_repo_async(repo_path, move |repo| git::image_pair(repo, &source)).await
}

#[tauri::command]
async fn compare_revisions(
    repo_path: String,
    base: String,
    head: String,
) -> AppResult<Vec<CommitFile>> {
    with_repo_async(repo_path, move |repo| git::compare_files(repo, &base, &head)).await
}

#[tauri::command]
async fn compare_file_diff(
    repo_path: String,
    base: String,
    head: String,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::compare_file_diff(repo, &base, &head, &path, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn stage_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn unstage_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::unstage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn apply_lines(
    repo_path: String,
    path: String,
    staged: bool,
    action: String,
    lines: Vec<git::LineRef>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::apply_lines(repo, &path, staged, &action, &lines)
    })
    .await
}

#[tauri::command]
async fn discard_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::discard_paths(repo, &paths)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn commit_changes(
    repo_path: String,
    message: String,
    amend: Option<bool>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::commit(repo, &message, amend.unwrap_or(false))?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn head_reflog(repo_path: String, limit: Option<usize>) -> AppResult<Vec<git::ReflogEntry>> {
    with_repo_async(repo_path, move |repo| git::head_reflog(repo, limit.unwrap_or(200))).await
}

#[tauri::command]
async fn undo_last_commit(repo_path: String) -> AppResult<git::UndoneCommit> {
    with_repo_async(repo_path, git::undo_last_commit).await
}

#[tauri::command]
async fn checkout_detached(repo_path: String, oid: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::checkout_detached(repo, &oid)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn checkout_branch(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::checkout_branch(repo, &name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn fetch_remote(
    repo_path: String,
    activity_id: Option<String>,
    remote: Option<String>,
    all: Option<bool>,
    prune: Option<bool>,
    background: Option<bool>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_background(background.unwrap_or(false), || {
            git::with_cancel(activity_id.as_deref(), || {
                git::fetch_remote(
                    repo,
                    remote.as_deref(),
                    all.unwrap_or(false),
                    prune.unwrap_or(false),
                    progress_sink(&app, activity_id.as_deref()),
                )
            })
        })
    })
    .await
}

#[tauri::command]
async fn pull_remote(
    repo_path: String,
    remote: Option<String>,
    rebase: Option<bool>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    let rebase = rebase.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::pull_remote(
                repo,
                remote.as_deref(),
                rebase,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn push_remote(
    repo_path: String,
    remote: Option<String>,
    force: Option<bool>,
    set_upstream: Option<bool>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    let force = force.unwrap_or(false);
    let set_upstream = set_upstream.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::push_remote(
                repo,
                remote.as_deref(),
                force,
                set_upstream,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[derive(Clone, Serialize)]
struct GitProgressEvent {
    id: String,
    line: String,
}

fn progress_sink(app: &AppHandle, activity_id: Option<&str>) -> impl FnMut(&str) + Send + 'static {
    let app = app.clone();
    let activity_id = activity_id.map(str::to_string);
    move |line: &str| {
        let Some(id) = activity_id.clone() else { return };
        let _ = app.emit(
            "git-progress",
            GitProgressEvent {
                id,
                line: line.to_string(),
            },
        );
    }
}

#[tauri::command]
async fn create_tag(
    repo_path: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::create_tag(repo, &name, message.as_deref(), target.as_deref())?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_tag(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::delete_tag(repo, &name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn push_tag(
    repo_path: String,
    remote: String,
    name: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::push_tag(repo, &remote, &name, progress_sink(&app, activity_id.as_deref()))
        })?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_remote_tag(
    repo_path: String,
    remote: String,
    name: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::delete_remote_tag(repo, &remote, &name, progress_sink(&app, activity_id.as_deref()))
        })
    })
    .await
}

#[tauri::command]
async fn create_branch(
    repo_path: String,
    name: String,
    switch: bool,
    start: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::create_branch(repo, &name, switch, start.as_deref())?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_branch(
    repo_path: String,
    name: String,
    force: Option<bool>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    let force = force.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::delete_branch(repo, &name, force, progress_sink(&app, activity_id.as_deref()))
        })
    })
    .await
}

#[tauri::command]
async fn revert_commit(repo_path: String, oid: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::revert_commit(repo, &oid)).await
}

#[tauri::command]
async fn cherry_pick_commit(repo_path: String, oid: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::cherry_pick_commit(repo, &oid)).await
}

#[tauri::command]
async fn rebase_plan(repo_path: String, onto: String) -> AppResult<Vec<RebaseCommit>> {
    with_repo_async(repo_path, move |repo| git::rebase_plan(repo, &onto)).await
}

#[tauri::command]
async fn rebase_onto(repo_path: String, onto: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::rebase_onto(repo, &onto)).await
}

#[tauri::command]
async fn rebase_interactive(
    repo_path: String,
    onto: String,
    steps: Vec<RebaseStep>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::rebase_interactive(repo, &onto, &steps)
    })
    .await
}

#[tauri::command]
async fn rebase_continue(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::rebase_continue).await
}

#[tauri::command]
async fn rebase_skip(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::rebase_skip).await
}

#[tauri::command]
async fn rebase_abort(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::rebase_abort).await
}

#[tauri::command]
async fn merge_ref(repo_path: String, onto: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::merge_ref(repo, &onto)).await
}

#[tauri::command]
async fn operation_continue(repo_path: String, message: Option<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::operation_continue(repo, message.as_deref())).await
}

#[tauri::command]
async fn operation_abort(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::operation_abort).await
}

#[tauri::command]
async fn resolve_conflict(
    repo_path: String,
    path: String,
    side: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::resolve_conflict(repo, &path, &side)).await
}

#[tauri::command]
async fn conflict_view(repo_path: String, path: String) -> AppResult<git::ConflictView> {
    with_repo_async(repo_path, move |repo| git::conflict_view(repo, &path)).await
}

#[tauri::command]
async fn save_conflict(repo_path: String, path: String, text: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::save_conflict(repo, &path, &text)).await
}

#[tauri::command]
async fn reset_to_commit(
    repo_path: String,
    oid: String,
    mode: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::reset_to_commit(repo, &oid, &mode)
    })
    .await
}

#[tauri::command]
async fn write_commit_patch(repo_path: String, oid: String, dest: String) -> AppResult<()> {
    with_repo_async(repo_path, move |repo| git::write_commit_patch(repo, &oid, &dest)).await
}

#[tauri::command]
async fn apply_patch(repo_path: String, patch_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::apply_patch(repo, &patch_path)).await
}

#[tauri::command]
async fn add_remote(repo_path: String, name: String, url: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::add_remote(repo, &name, &url)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn probe_remote_url(repo_path: String, url: String) -> AppResult<RemoteProbe> {
    with_repo_async(repo_path, move |repo| git::probe_remote_url(repo, &url)).await
}

#[tauri::command]
async fn set_remote_url(repo_path: String, name: String, url: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::set_remote_url(repo, &name, &url)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_remote(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::delete_remote(repo, &name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_save(
    repo_path: String,
    message: String,
    include_untracked: bool,
    paths: Option<Vec<String>>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_save(repo, &message, include_untracked, paths.as_deref().unwrap_or(&[]))?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_apply(repo_path: String, id: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_apply(repo, &id)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_pop(repo_path: String, id: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_pop(repo, &id)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_drop(repo_path: String, id: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_drop(repo, &id)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn get_stash_details(repo_path: String, oid: String) -> AppResult<StashDetails> {
    with_repo_async(repo_path, move |repo| git::stash_details(repo, &oid)).await
}

#[tauri::command]
async fn get_stash_diff(
    repo_path: String,
    oid: String,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::stash_file_diff(repo, &oid, &path, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn get_git_identity() -> AppResult<GitIdentity> {
    blocking(git::read_git_identity).await
}

#[tauri::command]
async fn set_git_identity(identity: GitIdentity) -> AppResult<GitIdentity> {
    blocking(move || {
        git::write_git_identity(&identity.name, &identity.email)?;
        git::read_git_identity()
    })
    .await
}

#[tauri::command]
async fn get_local_git_identity(repo_path: String) -> AppResult<GitIdentity> {
    with_repo_async(repo_path, |repo| git::read_local_git_identity(repo)).await
}

#[tauri::command]
async fn set_local_git_identity(repo_path: String, identity: GitIdentity) -> AppResult<GitIdentity> {
    with_repo_async(repo_path, move |repo| {
        git::write_local_git_identity(repo, &identity.name, &identity.email)?;
        git::read_local_git_identity(repo)
    })
    .await
}

#[tauri::command]
async fn open_in_file_manager(path: String) -> AppResult<()> {
    blocking(move || git::open_in_file_manager(&path)).await
}

#[tauri::command]
async fn reveal_in_file_manager(path: String) -> AppResult<()> {
    blocking(move || git::reveal_in_file_manager(&path)).await
}

#[tauri::command]
async fn ignore_patterns(repo_path: String, patterns: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::ignore_patterns(repo, &patterns)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn list_terminals() -> AppResult<Vec<TerminalOption>> {
    blocking(|| Ok(terminal::list_terminals())).await
}

#[tauri::command]
async fn list_editors() -> AppResult<Vec<editor::EditorOption>> {
    blocking(|| Ok(editor::list_editors())).await
}

#[tauri::command]
async fn open_in_editor(path: String, line: Option<u32>, app: AppHandle) -> AppResult<()> {
    blocking(move || {
        let prefs = prefs::load_prefs(&app)?;
        editor::open_in_editor(&path, line, &prefs.editor_id)
    })
    .await
}

#[tauri::command]
async fn get_tool_config(repo_path: Option<String>) -> AppResult<git::ToolConfig> {
    blocking(move || match repo_path {
        Some(path) => with_repo(&path, |repo| Ok(git::read_tool_config(Some(repo)))),
        None => Ok(git::read_tool_config(None)),
    })
    .await
}

#[tauri::command]
async fn set_tool_config(config: git::ToolConfig) -> AppResult<git::ToolConfig> {
    blocking(move || git::write_tool_config(&config)).await
}

#[derive(Clone, Serialize)]
struct ToolError {
    message: String,
}

#[tauri::command]
async fn open_difftool(repo_path: String, source: git::FileSource, app: AppHandle) -> AppResult<()> {
    with_repo_async(repo_path, move |repo| {
        git::launch_difftool(repo, &source, move |message| {
            let _ = app.emit("tool-error", ToolError { message });
        })
    })
    .await
}

#[tauri::command]
async fn run_mergetool(repo_path: String, path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::run_mergetool(repo, &path)).await
}

#[tauri::command]
async fn get_prefs(app: AppHandle) -> AppResult<AppPrefs> {
    blocking(move || prefs::load_prefs(&app)).await
}

// Kept synchronous so rapid saves land in the order they were sent.
#[tauri::command]
fn set_prefs(prefs: AppPrefs, app: AppHandle) -> AppResult<AppPrefs> {
    prefs::save_prefs(&app, prefs)
}

#[tauri::command]
async fn open_in_terminal(path: String, app: AppHandle) -> AppResult<()> {
    blocking(move || {
        let prefs = prefs::load_prefs(&app)?;
        terminal::open_in_terminal(&path, &prefs.terminal_id)
    })
    .await
}

#[tauri::command]
fn sync_watches(paths: Vec<String>, app: AppHandle, state: State<WatchState>) -> AppResult<()> {
    git::retain_log_streams(&paths);
    watch::sync_watches(&app, &state, paths)
}

#[tauri::command]
fn sync_window_chrome(theme: String, app: AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::msg("main window missing"))?;
    apply_window_chrome(&window, theme != "light");
    Ok(())
}

fn apply_window_chrome(window: &tauri::WebviewWindow, dark: bool) {
    let _ = window.set_theme(Some(if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }));
    #[cfg(windows)]
    apply_caption_color(window, dark);
}

#[cfg(windows)]
fn apply_caption_color(window: &tauri::WebviewWindow, dark: bool) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // COLORREF 0x00BBGGRR matching --background in index.css
    let caption: u32 = if dark { 0x00_17_17_17 } else { 0x00_FB_FB_FB };
    let text: u32 = if dark { 0x00_FF_FF_FF } else { 0x00_00_00_00 };
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    unsafe {
        let handle = hwnd.0;
        dwm_set_color(handle, DWMWA_CAPTION_COLOR, caption);
        dwm_set_color(handle, DWMWA_BORDER_COLOR, caption);
        dwm_set_color(handle, DWMWA_TEXT_COLOR, text);
    }
}

#[cfg(windows)]
unsafe fn dwm_set_color(hwnd: *mut std::ffi::c_void, attr: u32, color: u32) {
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            dw_attribute: u32,
            pv_attribute: *const std::ffi::c_void,
            cb_attribute: u32,
        ) -> i32;
    }
    unsafe {
        DwmSetWindowAttribute(hwnd, attr, (&color as *const u32).cast(), 4);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default())
        .setup(|app| {
            askpass::start(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                apply_window_chrome(&window, true);
                if let Ok(icon) = Image::from_bytes(APP_ICON_PNG) {
                    let _ = window.set_icon(icon);
                }
                window_state::restore(&window, app.handle());
                window_state::watch(&window, app.handle());
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_recents,
            forget_recent,
            load_session,
            save_session,
            clone_repository,
            cancel_activity,
            answer_askpass,
            open_repository,
            refresh_workspace,
            get_commits,
            get_branches,
            get_workdir_diff,
            get_commit_details,
            list_directory,
            read_file,
            file_blame,
            file_commits,
            get_commit_diff,
            compare_revisions,
            compare_file_diff,
            get_image_pair,
            stage_paths,
            unstage_paths,
            discard_paths,
            apply_lines,
            commit_changes,
            checkout_branch,
            checkout_detached,
            head_reflog,
            undo_last_commit,
            fetch_remote,
            pull_remote,
            push_remote,
            create_branch,
            create_tag,
            delete_tag,
            push_tag,
            delete_remote_tag,
            delete_branch,
            revert_commit,
            cherry_pick_commit,
            rebase_plan,
            rebase_onto,
            rebase_interactive,
            rebase_continue,
            rebase_skip,
            rebase_abort,
            merge_ref,
            operation_continue,
            operation_abort,
            resolve_conflict,
            conflict_view,
            save_conflict,
            reset_to_commit,
            write_commit_patch,
            apply_patch,
            add_remote,
            probe_remote_url,
            set_remote_url,
            delete_remote,
            stash_save,
            stash_apply,
            stash_pop,
            stash_drop,
            get_stash_details,
            get_stash_diff,
            get_git_identity,
            set_git_identity,
            get_local_git_identity,
            set_local_git_identity,
            open_in_file_manager,
            reveal_in_file_manager,
            ignore_patterns,
            list_terminals,
            list_editors,
            open_in_editor,
            get_tool_config,
            set_tool_config,
            open_difftool,
            run_mergetool,
            get_prefs,
            set_prefs,
            open_in_terminal,
            sync_watches,
            sync_window_chrome
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rebasely");
}
