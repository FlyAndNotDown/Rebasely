mod error;
mod git;
mod recents;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use error::{AppError, AppResult};
use git::{CommitDetails, CommitSummary, FileDiff, WorkspaceSnapshot};
use recents::RecentRepo;

#[derive(Default)]
struct AppState {
    repo_path: Mutex<Option<PathBuf>>,
}

fn with_repo<T>(state: &AppState, f: impl FnOnce(&git2::Repository) -> AppResult<T>) -> AppResult<T> {
    let path = state
        .repo_path
        .lock()
        .map_err(|_| AppError::msg("Repository state is locked"))?
        .clone()
        .ok_or_else(|| AppError::msg("Open a repository first"))?;
    let repo = git::open_at(&path)?;
    f(&repo)
}

#[tauri::command]
fn list_recents(app: AppHandle) -> AppResult<Vec<RecentRepo>> {
    recents::load_recents(&app)
}

#[tauri::command]
fn forget_recent(path: String, app: AppHandle) -> AppResult<Vec<RecentRepo>> {
    recents::forget_repo(&app, &path)
}

#[tauri::command]
fn open_repository(path: String, state: State<AppState>, app: AppHandle) -> AppResult<WorkspaceSnapshot> {
    let repo = git::discover(&path)?;
    let workdir = git::canonical_workdir(&repo)?;
    {
        let mut current = state
            .repo_path
            .lock()
            .map_err(|_| AppError::msg("Repository state is locked"))?;
        *current = Some(workdir.clone());
    }
    let snapshot = git::snapshot(&repo)?;
    recents::remember_repo(&app, &snapshot.repo.path, &snapshot.repo.name)?;
    Ok(snapshot)
}

#[tauri::command]
fn close_repository(state: State<AppState>) -> AppResult<()> {
    let mut current = state
        .repo_path
        .lock()
        .map_err(|_| AppError::msg("Repository state is locked"))?;
    *current = None;
    Ok(())
}

#[tauri::command]
fn refresh_workspace(state: State<AppState>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, git::snapshot)
}

#[tauri::command]
fn get_commits(state: State<AppState>, limit: Option<usize>) -> AppResult<Vec<CommitSummary>> {
    with_repo(&state, |repo| git::commits(repo, limit.unwrap_or(100)))
}

#[tauri::command]
fn get_workdir_diff(state: State<AppState>, path: String, staged: bool) -> AppResult<FileDiff> {
    with_repo(&state, |repo| git::workdir_diff(repo, &path, staged))
}

#[tauri::command]
fn get_commit_details(state: State<AppState>, oid: String) -> AppResult<CommitDetails> {
    with_repo(&state, |repo| git::commit_details(repo, &oid))
}

#[tauri::command]
fn get_commit_diff(state: State<AppState>, oid: String, path: String) -> AppResult<FileDiff> {
    with_repo(&state, |repo| git::commit_file_diff(repo, &oid, &path))
}

#[tauri::command]
fn stage_paths(state: State<AppState>, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, |repo| {
        git::stage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn unstage_paths(state: State<AppState>, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, |repo| {
        git::unstage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn discard_paths(state: State<AppState>, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, |repo| {
        git::discard_paths(repo, &paths)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn commit_changes(state: State<AppState>, message: String) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, |repo| {
        git::commit(repo, &message)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn checkout_branch(state: State<AppState>, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, |repo| {
        git::checkout_branch(repo, &name)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn create_branch(
    state: State<AppState>,
    name: String,
    switch: bool,
) -> AppResult<WorkspaceSnapshot> {
    with_repo(&state, |repo| {
        git::create_branch(repo, &name, switch)?;
        git::snapshot(repo)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_recents,
            forget_recent,
            open_repository,
            close_repository,
            refresh_workspace,
            get_commits,
            get_workdir_diff,
            get_commit_details,
            get_commit_diff,
            stage_paths,
            unstage_paths,
            discard_paths,
            commit_changes,
            checkout_branch,
            create_branch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rebasely");
}
