mod askpass;
mod editor;
mod error;
mod fsutil;
mod git;
mod locate;
mod p4;
mod prefs;
mod recents;
mod session;
mod sshkeys;
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
    GitIdentity, RebaseCommit, RebaseStep, RemoteProbe, StashDetails, WorkspaceSnapshot,
};
use prefs::AppPrefs;
use recents::RecentRepo;
use session::AppSession;
use terminal::TerminalOption;
use watch::WatchState;

fn with_repo<T>(path: &str, f: impl FnOnce(&mut git::Repository) -> AppResult<T>) -> AppResult<T> {
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
    F: FnOnce(&mut git::Repository) -> AppResult<T> + Send + 'static,
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
            git::clone_repository(
                &url,
                &destination,
                progress_sink(&app, activity_id.as_deref()),
            )
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
        recents::remember_repo(&app, &snapshot.repo.path, &snapshot.repo.name, "git")?;
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
    with_repo_async(repo_path, move |repo| {
        git::file_commits(repo, &path, limit, skip)
    })
    .await
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
    with_repo_async(repo_path, move |repo| {
        git::compare_files(repo, &base, &head)
    })
    .await
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
async fn list_submodules(repo_path: String) -> AppResult<Vec<git::SubmoduleInfo>> {
    with_repo_async(repo_path, |repo| git::list_submodules(repo)).await
}

#[tauri::command]
async fn update_submodules(
    repo_path: String,
    paths: Option<Vec<String>>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::update_submodules(
                repo,
                paths.as_deref().unwrap_or(&[]),
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn list_worktrees(repo_path: String) -> AppResult<Vec<git::WorktreeInfo>> {
    with_repo_async(repo_path, |repo| git::list_worktrees(repo)).await
}

#[tauri::command]
async fn add_worktree(
    repo_path: String,
    path: String,
    branch: Option<String>,
    new_branch: Option<String>,
    start: Option<String>,
) -> AppResult<String> {
    with_repo_async(repo_path, move |repo| {
        git::add_worktree(
            repo,
            &path,
            branch.as_deref(),
            new_branch.as_deref(),
            start.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn remove_worktree(repo_path: String, path: String, force: Option<bool>) -> AppResult<()> {
    with_repo_async(repo_path, move |repo| {
        git::remove_worktree(repo, &path, force.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn prune_worktrees(repo_path: String) -> AppResult<()> {
    with_repo_async(repo_path, |repo| git::prune_worktrees(repo)).await
}

#[tauri::command]
async fn head_reflog(repo_path: String, limit: Option<usize>) -> AppResult<Vec<git::ReflogEntry>> {
    with_repo_async(repo_path, move |repo| {
        git::head_reflog(repo, limit.unwrap_or(200))
    })
    .await
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
        let Some(id) = activity_id.clone() else {
            return;
        };
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
            git::push_tag(
                repo,
                &remote,
                &name,
                progress_sink(&app, activity_id.as_deref()),
            )
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
            git::delete_remote_tag(
                repo,
                &remote,
                &name,
                progress_sink(&app, activity_id.as_deref()),
            )
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
            git::delete_branch(
                repo,
                &name,
                force,
                progress_sink(&app, activity_id.as_deref()),
            )
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
async fn operation_continue(
    repo_path: String,
    message: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::operation_continue(repo, message.as_deref())
    })
    .await
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
    with_repo_async(repo_path, move |repo| {
        git::resolve_conflict(repo, &path, &side)
    })
    .await
}

#[tauri::command]
async fn conflict_view(repo_path: String, path: String) -> AppResult<git::ConflictView> {
    with_repo_async(repo_path, move |repo| git::conflict_view(repo, &path)).await
}

#[tauri::command]
async fn save_conflict(
    repo_path: String,
    path: String,
    text: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::save_conflict(repo, &path, &text)
    })
    .await
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
    with_repo_async(repo_path, move |repo| {
        git::write_commit_patch(repo, &oid, &dest)
    })
    .await
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
async fn set_remote_url(
    repo_path: String,
    name: String,
    url: String,
) -> AppResult<WorkspaceSnapshot> {
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
        git::stash_save(
            repo,
            &message,
            include_untracked,
            paths.as_deref().unwrap_or(&[]),
        )?;
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
async fn set_local_git_identity(
    repo_path: String,
    identity: GitIdentity,
) -> AppResult<GitIdentity> {
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
async fn open_mailto(email: String) -> AppResult<()> {
    blocking(move || editor::open_mailto(&email)).await
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

#[tauri::command]
async fn list_gui_tools() -> AppResult<Vec<git::GuiToolOption>> {
    blocking(|| Ok(git::list_gui_tools())).await
}

#[tauri::command]
async fn gui_tool_found(value: String) -> AppResult<bool> {
    blocking(move || Ok(git::gui_tool_found(&value))).await
}

#[derive(Clone, Serialize)]
struct ToolError {
    message: String,
}

#[tauri::command]
async fn open_difftool(
    repo_path: String,
    source: git::FileSource,
    app: AppHandle,
) -> AppResult<()> {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitExecutables {
    path_git: Option<String>,
    active: Option<String>,
}

#[tauri::command]
async fn git_executables() -> AppResult<GitExecutables> {
    blocking(|| {
        Ok(GitExecutables {
            path_git: git::git_on_path(),
            active: git::active_git(),
        })
    })
    .await
}

#[tauri::command]
async fn check_git_executable(path: String) -> AppResult<()> {
    blocking(move || git::check_git_executable(&path)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct P4Executables {
    path_p4: Option<String>,
    active: Option<String>,
}

#[tauri::command]
async fn detect_repository(path: String) -> AppResult<p4::RepoDetection> {
    blocking(move || p4::detect_repository(&path)).await
}

#[tauri::command]
async fn p4_open(path: String, app: AppHandle) -> AppResult<p4::P4Open> {
    blocking(move || {
        let opened = p4::open_workspace(&path)?;
        if let p4::P4Open::Ready { connection, .. } = &opened {
            let name = if connection.client.is_empty() {
                connection.root.clone()
            } else {
                connection.client.clone()
            };
            recents::remember_repo(&app, &connection.root, &name, "perforce")?;
        }
        Ok(opened)
    })
    .await
}

#[tauri::command]
async fn p4_refresh_pending(connection: p4::P4Connection) -> AppResult<Vec<p4::P4Changelist>> {
    blocking(move || p4::refresh_pending(&connection)).await
}

#[tauri::command]
async fn p4_submitted(
    connection: p4::P4Connection,
    limit: Option<usize>,
    before: Option<i64>,
) -> AppResult<p4::P4ChangePage> {
    blocking(move || p4::submitted(&connection, limit.unwrap_or(50), before)).await
}

#[tauri::command]
async fn p4_describe(connection: p4::P4Connection, change_id: String) -> AppResult<p4::P4Describe> {
    blocking(move || p4::describe(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_opened_diff(connection: p4::P4Connection, path: String) -> AppResult<git::FileDiff> {
    blocking(move || p4::opened_diff(&connection, &path)).await
}

#[tauri::command]
async fn p4_revision_diff(
    connection: p4::P4Connection,
    depot_path: String,
    rev: String,
) -> AppResult<git::FileDiff> {
    blocking(move || p4::revision_diff(&connection, &depot_path, &rev)).await
}

#[tauri::command]
async fn p4_filelog(connection: p4::P4Connection, path: String) -> AppResult<Vec<p4::P4Revision>> {
    blocking(move || p4::filelog(&connection, &path)).await
}

#[tauri::command]
async fn p4_list_dir(
    connection: p4::P4Connection,
    relative: String,
) -> AppResult<Vec<p4::P4DirEntry>> {
    blocking(move || p4::list_dir(&connection, &relative)).await
}

#[tauri::command]
async fn p4_submit(
    connection: p4::P4Connection,
    change_id: String,
    description: String,
) -> AppResult<()> {
    blocking(move || p4::submit(&connection, &change_id, &description)).await
}

#[tauri::command]
async fn p4_save_change(
    connection: p4::P4Connection,
    change_id: String,
    description: String,
) -> AppResult<String> {
    blocking(move || p4::save_change(&connection, &change_id, &description)).await
}

#[tauri::command]
async fn p4_new_change(connection: p4::P4Connection, description: String) -> AppResult<String> {
    blocking(move || p4::new_change(&connection, &description)).await
}

#[tauri::command]
async fn p4_reopen(
    connection: p4::P4Connection,
    change_id: String,
    files: Vec<String>,
) -> AppResult<()> {
    blocking(move || p4::reopen(&connection, &change_id, &files)).await
}

#[tauri::command]
async fn p4_revert(connection: p4::P4Connection, files: Vec<String>) -> AppResult<()> {
    blocking(move || p4::revert(&connection, &files)).await
}

#[tauri::command]
async fn p4_revert_unchanged(connection: p4::P4Connection) -> AppResult<()> {
    blocking(move || p4::revert_unchanged(&connection)).await
}

#[tauri::command]
async fn p4_shelve(connection: p4::P4Connection, change_id: String) -> AppResult<()> {
    blocking(move || p4::shelve(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_unshelve(connection: p4::P4Connection, change_id: String) -> AppResult<()> {
    blocking(move || p4::unshelve(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_delete_shelf(connection: p4::P4Connection, change_id: String) -> AppResult<()> {
    blocking(move || p4::delete_shelf(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_sync(
    connection: p4::P4Connection,
    paths: Vec<String>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<String> {
    blocking(move || {
        p4::sync(
            &connection,
            &paths,
            progress_sink(&app, activity_id.as_deref()),
        )
    })
    .await
}

#[tauri::command]
async fn p4_reconcile(
    connection: p4::P4Connection,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<String> {
    blocking(move || p4::reconcile(&connection, progress_sink(&app, activity_id.as_deref()))).await
}

#[tauri::command]
async fn p4_file_action(
    connection: p4::P4Connection,
    action: String,
    paths: Vec<String>,
) -> AppResult<()> {
    blocking(move || p4::file_action(&connection, &action, &paths)).await
}

#[tauri::command]
async fn p4_login(connection: p4::P4Connection, password: String) -> AppResult<()> {
    blocking(move || p4::login(&connection, &password)).await
}

#[tauri::command]
async fn p4_create_workspace(
    request: p4::P4CreateRequest,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<p4::P4Connection> {
    blocking(move || p4::create_workspace(request, progress_sink(&app, activity_id.as_deref())))
        .await
}

#[tauri::command]
async fn p4_executables() -> AppResult<P4Executables> {
    blocking(|| {
        Ok(P4Executables {
            path_p4: p4::p4_on_path(),
            active: p4::active_p4(),
        })
    })
    .await
}

#[tauri::command]
async fn check_p4_executable(path: String) -> AppResult<()> {
    blocking(move || p4::check_p4_executable(&path)).await
}

#[tauri::command]
async fn list_ssh_keys() -> AppResult<sshkeys::SshKeyList> {
    blocking(sshkeys::list).await
}

#[tauri::command]
async fn preview_ssh_key(path: String) -> AppResult<sshkeys::SshKeyPreview> {
    blocking(move || sshkeys::preview(&path)).await
}

#[tauri::command]
async fn generate_ssh_key(
    name: String,
    algorithm: String,
    comment: String,
    passphrase: String,
) -> AppResult<sshkeys::SshKeyInfo> {
    blocking(move || sshkeys::generate(&name, &algorithm, &comment, &passphrase)).await
}

#[tauri::command]
async fn import_ssh_key(path: String, passphrase: String) -> AppResult<sshkeys::SshKeyInfo> {
    blocking(move || sshkeys::import(&path, &passphrase)).await
}

#[tauri::command]
async fn delete_ssh_key(name: String) -> AppResult<()> {
    blocking(move || sshkeys::delete(&name)).await
}

#[tauri::command]
async fn get_prefs(app: AppHandle) -> AppResult<AppPrefs> {
    blocking(move || prefs::load_prefs(&app)).await
}

// Kept synchronous so rapid saves land in the order they were sent.
#[tauri::command]
fn set_prefs(mut prefs: AppPrefs, app: AppHandle) -> AppResult<AppPrefs> {
    let extras = std::mem::take(&mut prefs.extra_git_paths);
    let (git_path, extra_git_paths) = git::prepare_git_prefs(&prefs.git_path, extras)?;
    prefs.git_path = git_path;
    prefs.extra_git_paths = extra_git_paths;
    let p4_extras = std::mem::take(&mut prefs.extra_p4_paths);
    let (p4_path, extra_p4_paths) = p4::prepare_p4_prefs(&prefs.p4_path, p4_extras)?;
    prefs.p4_path = p4_path;
    prefs.extra_p4_paths = extra_p4_paths;
    prefs.p4_port = clean_setting(&prefs.p4_port);
    prefs.p4_user = clean_setting(&prefs.p4_user);
    prefs.p4_charset = p4::normalize_charset(&prefs.p4_charset);
    let saved = prefs::save_prefs(&app, prefs)?;
    git::set_git_executable(&saved.git_path);
    p4::set_p4_executable(&saved.p4_path);
    Ok(saved)
}

fn clean_setting(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| *ch != '\n' && *ch != '\r')
        .collect()
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

#[cfg(target_os = "macos")]
fn macos_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
    // Close Window is omitted. Command-W closes the repository tab.
    let app_menu = Submenu::with_items(
        app,
        "Rebasely",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| macos_menu(app));
    builder
        .setup(|app| {
            if let Ok(prefs) = prefs::load_prefs(app.handle()) {
                git::set_git_executable(&prefs.git_path);
                p4::set_p4_executable(&prefs.p4_path);
            }
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
            list_submodules,
            update_submodules,
            list_worktrees,
            add_worktree,
            remove_worktree,
            prune_worktrees,
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
            open_mailto,
            reveal_in_file_manager,
            ignore_patterns,
            list_terminals,
            list_editors,
            open_in_editor,
            get_tool_config,
            set_tool_config,
            list_gui_tools,
            gui_tool_found,
            open_difftool,
            run_mergetool,
            git_executables,
            check_git_executable,
            detect_repository,
            p4_open,
            p4_refresh_pending,
            p4_submitted,
            p4_describe,
            p4_opened_diff,
            p4_revision_diff,
            p4_filelog,
            p4_list_dir,
            p4_submit,
            p4_save_change,
            p4_new_change,
            p4_reopen,
            p4_revert,
            p4_revert_unchanged,
            p4_shelve,
            p4_unshelve,
            p4_delete_shelf,
            p4_sync,
            p4_reconcile,
            p4_file_action,
            p4_login,
            p4_create_workspace,
            p4_executables,
            check_p4_executable,
            list_ssh_keys,
            preview_ssh_key,
            generate_ssh_key,
            import_ssh_key,
            delete_ssh_key,
            get_prefs,
            set_prefs,
            open_in_terminal,
            sync_watches,
            sync_window_chrome
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rebasely");
}
