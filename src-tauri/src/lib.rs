mod error;
mod git;
mod recents;

use std::path::Path;

use tauri::AppHandle;

use error::AppResult;
use git::{CommitDetails, CommitSummary, FileDiff, WorkspaceSnapshot};
use recents::RecentRepo;

fn with_repo<T>(path: &str, f: impl FnOnce(&git2::Repository) -> AppResult<T>) -> AppResult<T> {
    let path = git::strip_verbatim_prefix(path);
    let repo = git::open_at(Path::new(&path))?;
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
fn open_repository(path: String, app: AppHandle) -> AppResult<WorkspaceSnapshot> {
    let repo = git::discover(&path)?;
    let snapshot = git::snapshot(&repo)?;
    recents::remember_repo(&app, &snapshot.repo.path, &snapshot.repo.name)?;
    Ok(snapshot)
}

#[tauri::command]
fn refresh_workspace(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, git::snapshot)
}

#[tauri::command]
fn get_commits(repo_path: String, limit: Option<usize>) -> AppResult<Vec<CommitSummary>> {
    with_repo(&repo_path, |repo| git::commits(repo, limit.unwrap_or(100)))
}

#[tauri::command]
fn get_workdir_diff(repo_path: String, path: String, staged: bool) -> AppResult<FileDiff> {
    with_repo(&repo_path, |repo| git::workdir_diff(repo, &path, staged))
}

#[tauri::command]
fn get_commit_details(repo_path: String, oid: String) -> AppResult<CommitDetails> {
    with_repo(&repo_path, |repo| git::commit_details(repo, &oid))
}

#[tauri::command]
fn get_commit_diff(repo_path: String, oid: String, path: String) -> AppResult<FileDiff> {
    with_repo(&repo_path, |repo| git::commit_file_diff(repo, &oid, &path))
}

#[tauri::command]
fn stage_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, |repo| {
        git::stage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn unstage_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, |repo| {
        git::unstage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn discard_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, |repo| {
        git::discard_paths(repo, &paths)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn commit_changes(repo_path: String, message: String) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, |repo| {
        git::commit(repo, &message)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn checkout_branch(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, |repo| {
        git::checkout_branch(repo, &name)?;
        git::snapshot(repo)
    })
}

#[tauri::command]
fn create_branch(repo_path: String, name: String, switch: bool) -> AppResult<WorkspaceSnapshot> {
    with_repo(&repo_path, |repo| {
        git::create_branch(repo, &name, switch)?;
        git::snapshot(repo)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_recents,
            forget_recent,
            open_repository,
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
