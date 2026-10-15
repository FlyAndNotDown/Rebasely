//! Perforce workspace commands.
//!
//! A workspace is a client: a server, a user, and a view mapped onto a local
//! root. History lives on the server, so reads go through `p4` rather than a
//! local commit graph.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, P4_LOGIN, P4_MISSING};
use crate::git::{strip_verbatim_prefix, FileDiff};
use crate::p4::cli::{self, P4Env};
use crate::p4::parse::{
    blank_change_spec, classic_client_spec, created_change_id, depot_view, indexed_groups,
    known_p4_value, normalize_charset, parse_describe_diffs, parse_p4_set, parse_p4config,
    parse_single_diff, parse_ztag, path_depth, path_is_within, read_description, set_description,
    set_spec_field, valid_client_name, valid_depot_path, view_depots, ZtagRecord,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Auth {
    pub port: String,
    pub user: String,
    pub password: String,
    pub charset: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ClientOption {
    pub name: String,
    pub root: String,
    pub stream: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamOption {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4DepotEntry {
    pub path: String,
    pub dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CheckedConnection {
    pub server: String,
    pub clients: Vec<P4ClientOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Connection {
    pub root: String,
    pub port: String,
    pub user: String,
    pub client: String,
    pub charset: String,
    pub stream: Option<String>,
    pub server: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4File {
    pub depot_path: String,
    pub local_path: String,
    pub action: String,
    pub rev: String,
    pub shelved: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Changelist {
    pub id: String,
    pub user: String,
    pub client: String,
    pub status: String,
    pub description: String,
    pub time: i64,
    pub shelved: bool,
    pub files: Vec<P4File>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum P4Open {
    Ready {
        connection: P4Connection,
        pending: Vec<P4Changelist>,
    },
    Login {
        connection: P4Connection,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoDetection {
    Git {
        path: String,
    },
    Perforce {
        connection: P4Connection,
    },
    Ambiguous {
        path: String,
        git_path: String,
        connection: P4Connection,
    },
    None {
        path: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ChangePage {
    pub changes: Vec<P4Changelist>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Describe {
    pub change: P4Changelist,
    pub diffs: Vec<FileDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Revision {
    pub rev: String,
    pub change: String,
    pub action: String,
    pub user: String,
    pub time: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4DirEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CreateRequest {
    pub port: String,
    pub user: String,
    pub password: String,
    pub client: String,
    pub root: String,
    pub stream: String,
    pub depot_path: String,
    pub charset: String,
}

struct ConfigFile {
    directory: PathBuf,
    values: BTreeMap<String, String>,
}

pub fn detect_repository(path: &str) -> AppResult<RepoDetection> {
    let start = existing_dir(path)?;
    let git = git_root(&start)?;
    let p4 = match p4_connection(&start) {
        Ok(value) => value,
        Err(err) if err.to_string() == P4_MISSING && git.is_some() => None,
        Err(err) => return Err(err),
    };
    let selected = start.to_string_lossy().into_owned();
    match (git, p4) {
        (Some(git_path), Some(connection)) => pick_closer(&start, selected, git_path, connection),
        (Some(git_path), None) => Ok(RepoDetection::Git { path: git_path }),
        (None, Some(connection)) => Ok(RepoDetection::Perforce { connection }),
        (None, None) => Ok(RepoDetection::None { path: selected }),
    }
}

fn pick_closer(
    start: &Path,
    selected: String,
    git_path: String,
    connection: P4Connection,
) -> AppResult<RepoDetection> {
    let git_depth = path_depth(Path::new(&git_path), start);
    let p4_depth = path_depth(Path::new(&connection.root), start);
    Ok(match (git_depth, p4_depth) {
        (Some(git_depth), Some(p4_depth)) if git_depth < p4_depth => {
            RepoDetection::Git { path: git_path }
        }
        (Some(git_depth), Some(p4_depth)) if p4_depth < git_depth => {
            RepoDetection::Perforce { connection }
        }
        (Some(_), Some(_)) => RepoDetection::Ambiguous {
            path: selected,
            git_path,
            connection,
        },
        (Some(_), None) => RepoDetection::Git { path: git_path },
        (None, Some(_)) => RepoDetection::Perforce { connection },
        (None, None) => RepoDetection::None { path: selected },
    })
}

pub fn open_workspace(path: &str) -> AppResult<P4Open> {
    let start = existing_dir(path)?;
    let Some(connection) = p4_connection(&start)? else {
        return Err(AppError::msg(format!(
            "No Perforce workspace found at {}",
            start.to_string_lossy()
        )));
    };
    match load_pending(&connection) {
        Ok(pending) => Ok(P4Open::Ready {
            connection,
            pending,
        }),
        Err(err) if err.to_string() == P4_LOGIN => Ok(P4Open::Login { connection }),
        Err(err) => Err(err),
    }
}

pub fn refresh_pending(connection: &P4Connection) -> AppResult<Vec<P4Changelist>> {
    load_pending(connection)
}

pub fn submitted(
    connection: &P4Connection,
    user: &str,
    client: &str,
    limit: usize,
    before: Option<i64>,
) -> AppResult<P4ChangePage> {
    let env = env_for(connection);
    let limit = limit.clamp(1, 200);
    let user = optional_name(user)?;
    let client = optional_name(client)?;
    let mut args = vec![
        "-ztag".to_string(),
        "changes".into(),
        "-s".into(),
        "submitted".into(),
        "-m".into(),
        limit.to_string(),
        "-L".into(),
    ];
    if let Some(user) = &user {
        args.push("-u".into());
        args.push(user.clone());
    }
    if let Some(client) = &client {
        args.push("-c".into());
        args.push(client.clone());
    }
    // A user or workspace already scopes the query. A depot path on top of that
    // hides this client's own submits when the stream view does not match them.
    if user.is_none() && client.is_none() {
        for spec in history_specs(&env, connection)? {
            args.push(match before {
                Some(change) if change > 1 => format!("{spec}@1,@{}", change - 1),
                _ => spec,
            });
        }
    } else if let Some(change) = before.filter(|change| *change > 1) {
        args.push(format!("@1,@{}", change - 1));
    }
    let stdout = run_owned(&env, &args, None)?;
    let mut changes = Vec::new();
    for record in parse_ztag(&stdout) {
        changes.push(change_from_record(&record, Vec::new(), false));
    }
    let has_more = changes.len() >= limit;
    Ok(P4ChangePage { changes, has_more })
}

pub fn describe(connection: &P4Connection, change_id: &str) -> AppResult<P4Describe> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    let meta = run_ok(&env, &["-ztag", "describe", "-s", &id], None)?;
    let diff_text = cli::run_p4_diff(&env, &["describe", "-du", &id])?;
    let record = parse_ztag(&meta).into_iter().next().unwrap_or_default();
    let files = files_from_groups(connection, &indexed_groups(&record), false);
    let diffs = parse_describe_diffs(&diff_text);
    Ok(P4Describe {
        change: change_from_record(&record, files, false),
        diffs,
    })
}

pub fn opened_diff(connection: &P4Connection, path: &str) -> AppResult<FileDiff> {
    let env = env_for(connection);
    let text = cli::run_p4_diff(&env, &["diff", "-du", path])?;
    Ok(parse_single_diff(&text, path))
}

pub fn shelf_diff(
    connection: &P4Connection,
    depot_path: &str,
    change_id: &str,
) -> AppResult<FileDiff> {
    let id = require_numbered(change_id)?;
    if !depot_path.starts_with("//") {
        return Err(AppError::msg("Shelf diff needs a depot path."));
    }
    let env = env_for(connection);
    let have = format!("{depot_path}#have");
    let shelf = format!("{depot_path}@={id}");
    let text = cli::run_p4_diff(&env, &["diff2", "-du", &have, &shelf])?;
    Ok(parse_single_diff(&text, depot_path))
}

pub fn revision_diff(connection: &P4Connection, path: &str, rev: &str) -> AppResult<FileDiff> {
    let rev_no: u32 = rev
        .trim()
        .parse()
        .map_err(|_| AppError::msg("Revision is not a number."))?;
    let env = env_for(connection);
    let depot_path = if path.starts_with("//") {
        path.to_string()
    } else {
        let stdout = run_ok(&env, &["-ztag", "where", path], None)?;
        let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
        let depot = field(&record, "depotFile");
        if depot.starts_with("//") {
            depot
        } else {
            return Err(AppError::msg("File history needs a depot path."));
        }
    };
    if rev_no <= 1 {
        let text = run_ok(
            &env,
            &["print", "-q", &format!("{depot_path}#{rev_no}")],
            None,
        )?;
        return Ok(added_file_diff(&depot_path, &text));
    }
    let spec = format!("{depot_path}#{rev_no}");
    let previous = format!("{depot_path}#{}", rev_no - 1);
    let text = cli::run_p4_diff(&env, &["diff2", "-du", &previous, &spec])?;
    Ok(parse_single_diff(&text, &depot_path))
}

pub fn filelog(connection: &P4Connection, path: &str) -> AppResult<Vec<P4Revision>> {
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "filelog", "-m", "40", "-t", path], None)?;
    let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
    let mut revisions = Vec::new();
    for group in indexed_groups(&record) {
        let rev = field(&group, "rev");
        if rev.is_empty() {
            continue;
        }
        revisions.push(P4Revision {
            rev,
            change: field(&group, "change"),
            action: field(&group, "action"),
            user: field(&group, "user"),
            time: field_i64(&group, "time"),
            description: clean_description(&field(&group, "desc")),
        });
    }
    Ok(revisions)
}

pub fn list_dir(connection: &P4Connection, relative: &str) -> AppResult<Vec<P4DirEntry>> {
    let root = PathBuf::from(&connection.root);
    let relative = relative.trim().trim_matches(['/', '\\']);
    let dir = if relative.is_empty() {
        root.clone()
    } else {
        root.join(relative)
    };
    if !path_is_within(&root, &dir) {
        return Err(AppError::msg("Path is outside the workspace."));
    }
    if !dir.is_dir() {
        return Err(AppError::msg("Folder not found."));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        entries.push(P4DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .dir
            .cmp(&left.dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn submit(connection: &P4Connection, change_id: &str, description: &str) -> AppResult<()> {
    require_description(description)?;
    let env = env_for(connection);
    let spec = set_description(&change_spec(&env, change_id)?, description);
    run_ok(&env, &["submit", "-i"], Some(&spec))?;
    Ok(())
}

pub fn save_change(
    connection: &P4Connection,
    change_id: &str,
    description: &str,
) -> AppResult<String> {
    require_description(description)?;
    let env = env_for(connection);
    let spec = set_description(&change_spec(&env, change_id)?, description);
    let output = run_ok(&env, &["change", "-i"], Some(&spec))?;
    Ok(created_change_id(&output).unwrap_or_else(|| change_id.to_string()))
}

pub fn new_change(connection: &P4Connection, description: &str) -> AppResult<String> {
    require_description(description)?;
    let env = env_for(connection);
    let spec = blank_change_spec(&connection.client, &connection.user, description);
    let output = run_ok(&env, &["change", "-i"], Some(&spec))?;
    created_change_id(&output).ok_or_else(|| AppError::msg(output.trim().to_string()))
}

pub fn reopen(connection: &P4Connection, change_id: &str, files: &[String]) -> AppResult<()> {
    if files.is_empty() {
        return Ok(());
    }
    let target = if change_id == "default" {
        "default"
    } else {
        change_id
    };
    let env = env_for(connection);
    let mut args = vec!["reopen".to_string(), "-c".into(), target.into()];
    args.extend(files.iter().cloned());
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn revert(connection: &P4Connection, files: &[String]) -> AppResult<()> {
    if files.is_empty() {
        return Err(AppError::msg("Choose a file to revert."));
    }
    let env = env_for(connection);
    let mut args = vec!["revert".to_string()];
    args.extend(files.iter().cloned());
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn revert_unchanged(connection: &P4Connection) -> AppResult<()> {
    let env = env_for(connection);
    run_ok(&env, &["revert", "-a"], None)?;
    Ok(())
}

pub fn shelve(connection: &P4Connection, change_id: &str) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    run_ok(&env, &["shelve", "-f", "-c", &id], None)?;
    Ok(())
}

pub fn unshelve(connection: &P4Connection, change_id: &str) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    run_ok(&env, &["unshelve", "-s", &id], None)?;
    Ok(())
}

pub fn delete_shelf(connection: &P4Connection, change_id: &str) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    run_ok(&env, &["shelve", "-d", "-c", &id], None)?;
    Ok(())
}

pub fn sync(
    connection: &P4Connection,
    paths: &[String],
    mut progress: impl FnMut(&str),
) -> AppResult<String> {
    let env = env_for(connection);
    let mut args = vec!["sync".to_string()];
    args.extend(paths.iter().cloned());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_p4_stream(&env, &refs, &mut progress)
}

pub fn reconcile(connection: &P4Connection, mut progress: impl FnMut(&str)) -> AppResult<String> {
    let env = env_for(connection);
    cli::run_p4_stream(&env, &["reconcile", "-e", "-a", "-d"], &mut progress)
}

pub fn file_action(connection: &P4Connection, action: &str, paths: &[String]) -> AppResult<()> {
    let command = match action {
        "edit" | "add" | "delete" => action,
        _ => return Err(AppError::msg("Unsupported file action.")),
    };
    if paths.is_empty() {
        return Err(AppError::msg("Choose a file."));
    }
    let env = env_for(connection);
    let mut args = vec![command.to_string()];
    args.extend(paths.iter().cloned());
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn login(connection: &P4Connection, password: &str) -> AppResult<()> {
    cli::login(&env_for(connection), password)
}

pub fn create_workspace(
    request: P4CreateRequest,
    mut progress: impl FnMut(&str),
) -> AppResult<P4Connection> {
    let port = request.port.trim().to_string();
    let user = request.user.trim().to_string();
    let client = request.client.trim().to_string();
    let stream = request.stream.trim().to_string();
    let depot_path = request.depot_path.trim().to_string();
    let charset = normalize_charset(&request.charset);
    if port.is_empty() || port.contains(char::is_whitespace) {
        return Err(AppError::msg(
            "Enter a server address, for example ssl:perforce.example.com:1666.",
        ));
    }
    if user.is_empty() || user.contains(char::is_whitespace) {
        return Err(AppError::msg("Enter a Perforce user."));
    }
    if !valid_client_name(&client) {
        return Err(AppError::msg(
            "Client name can use letters, numbers, dots, hyphens, and underscores.",
        ));
    }
    if stream.is_empty() && depot_path.is_empty() {
        return Err(AppError::msg("Enter a stream or a depot path."));
    }
    if !stream.is_empty() && !depot_path.is_empty() {
        return Err(AppError::msg("Enter a stream or a depot path, not both."));
    }
    if !stream.is_empty() && !valid_depot_path(&stream) {
        return Err(AppError::msg("Stream should look like //depot/main."));
    }
    if !depot_path.is_empty() && !valid_depot_path(&depot_path) {
        return Err(AppError::msg(
            "Depot path should look like //depot/project.",
        ));
    }
    let root = PathBuf::from(strip_verbatim_prefix(request.root.trim()));
    if !root.is_absolute() {
        return Err(AppError::msg(
            "Choose an absolute folder for the workspace.",
        ));
    }
    fs::create_dir_all(&root)?;
    let env = P4Env {
        cwd: root.clone(),
        port: port.clone(),
        user: user.clone(),
        client: client.clone(),
        charset: charset.clone(),
    };
    if !request.password.is_empty() {
        cli::login(&env, request.password.trim())?;
    }
    if client_exists(&env, &client)? {
        return Err(AppError::msg(format!("Client '{client}' already exists.")));
    }
    let spec = if stream.is_empty() {
        classic_client_spec(&client, &user, &root.to_string_lossy(), &depot_path)
    } else {
        let current = run_ok(&env, &["client", "-S", &stream, "-o", &client], None)?;
        set_spec_field(&current, "Root", &root.to_string_lossy())
    };
    run_ok(&env, &["client", "-i"], Some(&spec))?;
    write_config(&root, &env)?;
    let connection = connection_after_create(&env, &root, &stream)?;
    if let Err(err) = sync(&connection, &[], &mut progress) {
        return Err(AppError::msg(format!(
            "Workspace '{client}' was created, but sync failed: {err}"
        )));
    }
    Ok(connection)
}

pub fn check_connection(auth: &P4Auth) -> AppResult<P4CheckedConnection> {
    let env = prepare_auth(auth)?;
    let info = run_ok(&env, &["-ztag", "info"], None)?;
    let record = parse_ztag(&info).into_iter().next().unwrap_or_default();
    let server = record
        .get("serverAddress")
        .filter(|value| known_p4_value(value))
        .cloned()
        .unwrap_or_else(|| env.port.clone());
    Ok(P4CheckedConnection {
        server,
        clients: list_clients(&env)?,
    })
}

pub fn list_streams(auth: &P4Auth) -> AppResult<Vec<P4StreamOption>> {
    let env = prepare_auth(auth)?;
    let stdout = run_ok(&env, &["-ztag", "streams", "-m", "2000"], None)?;
    let mut streams = Vec::new();
    for record in parse_ztag(&stdout) {
        let path = field(&record, "Stream");
        if !valid_depot_path(&path) {
            continue;
        }
        streams.push(P4StreamOption {
            path,
            kind: field(&record, "Type"),
        });
    }
    streams.sort_by_key(|item| item.path.to_lowercase());
    Ok(streams)
}

pub fn list_depot_dirs(auth: &P4Auth, path: &str) -> AppResult<Vec<P4DepotEntry>> {
    let env = prepare_auth(auth)?;
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || path == "//" {
        let stdout = run_ok(&env, &["-ztag", "depots"], None)?;
        let mut entries = Vec::new();
        for record in parse_ztag(&stdout) {
            let name = field(&record, "name");
            if name.is_empty() || name.contains([' ', '*', '?', '#', '@']) {
                continue;
            }
            entries.push(P4DepotEntry {
                path: format!("//{name}"),
                dir: true,
            });
        }
        entries.sort_by_key(|item| item.path.to_lowercase());
        return Ok(entries);
    }
    if !valid_depot_path(path) {
        return Err(AppError::msg(
            "Depot path should look like //depot/project.",
        ));
    }
    let spec = format!("{path}/*");
    let stdout = run_ok(&env, &["-ztag", "dirs", &spec], None)?;
    let mut entries = Vec::new();
    for record in parse_ztag(&stdout) {
        let dir = field(&record, "dir");
        if !valid_depot_path(&dir) {
            continue;
        }
        entries.push(P4DepotEntry {
            path: dir,
            dir: true,
        });
    }
    entries.sort_by_key(|item| item.path.to_lowercase());
    Ok(entries)
}

/// Point a local client root at this server user and client, then return that root.
pub fn prepare_client(auth: &P4Auth, name: &str) -> AppResult<String> {
    let name = name.trim();
    if !valid_client_name(name) {
        return Err(AppError::msg(
            "Client name can use letters, numbers, dots, hyphens, and underscores.",
        ));
    }
    let mut env = prepare_auth(auth)?;
    env.client = name.to_string();
    let stdout = run_ok(&env, &["-ztag", "info"], None)?;
    let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
    let root_text = record
        .get("clientRoot")
        .filter(|value| known_p4_value(value))
        .cloned()
        .unwrap_or_default();
    if root_text.is_empty() {
        return Err(AppError::msg("That client has no local root."));
    }
    let root = PathBuf::from(strip_verbatim_prefix(&root_text));
    if !root.is_dir() {
        return Err(AppError::msg(format!(
            "Client root is not on this machine: {}",
            root.display()
        )));
    }
    update_config_file(&root, &env)?;
    Ok(root.to_string_lossy().into_owned())
}

fn prepare_auth(auth: &P4Auth) -> AppResult<P4Env> {
    let port = auth.port.trim().to_string();
    let user = auth.user.trim().to_string();
    if port.is_empty() || port.contains(char::is_whitespace) {
        return Err(AppError::msg(
            "Enter a server address, for example ssl:perforce.example.com:1666.",
        ));
    }
    if user.is_empty() || user.contains(char::is_whitespace) {
        return Err(AppError::msg("Enter a Perforce user."));
    }
    let env = P4Env {
        cwd: PathBuf::new(),
        port,
        user,
        client: String::new(),
        charset: normalize_charset(&auth.charset),
    };
    if !auth.password.trim().is_empty() {
        cli::login(&env, auth.password.trim())?;
    }
    Ok(env)
}

pub fn list_users(connection: &P4Connection) -> AppResult<Vec<String>> {
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "users", "-m", "2000"], None)?;
    let mut users = Vec::new();
    for record in parse_ztag(&stdout) {
        let name = field(&record, "User");
        if valid_client_name(&name) && !users.contains(&name) {
            users.push(name);
        }
    }
    users.sort_by_key(|item| item.to_lowercase());
    Ok(users)
}

pub fn list_user_clients(connection: &P4Connection, user: &str) -> AppResult<Vec<String>> {
    let user = require_name(user)?;
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "clients", "-u", &user], None)?;
    let mut clients = Vec::new();
    for record in parse_ztag(&stdout) {
        let name = field(&record, "client");
        if valid_client_name(&name) && !clients.contains(&name) {
            clients.push(name);
        }
    }
    clients.sort_by_key(|item| item.to_lowercase());
    Ok(clients)
}

fn list_clients(env: &P4Env) -> AppResult<Vec<P4ClientOption>> {
    let stdout = run_ok(env, &["-ztag", "clients", "-u", &env.user], None)?;
    let mut clients = Vec::new();
    for record in parse_ztag(&stdout) {
        let name = field(&record, "client");
        if !valid_client_name(&name) {
            continue;
        }
        let stream = record
            .get("Stream")
            .cloned()
            .filter(|value| known_p4_value(value))
            .unwrap_or_default();
        let description = record
            .get("Description")
            .map(|value| {
                value
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        clients.push(P4ClientOption {
            name,
            root: record.get("Root").cloned().unwrap_or_default(),
            stream,
            description,
        });
    }
    clients.sort_by_key(|item| item.name.to_lowercase());
    Ok(clients)
}

fn connection_after_create(env: &P4Env, root: &Path, stream: &str) -> AppResult<P4Connection> {
    let stdout = run_ok(env, &["-ztag", "info"], None).unwrap_or_default();
    let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
    let reported = record
        .get("clientRoot")
        .map(|value| PathBuf::from(strip_verbatim_prefix(value)));
    let root = reported.unwrap_or_else(|| root.to_path_buf());
    let reported_stream = record
        .get("clientStream")
        .cloned()
        .filter(|value| known_p4_value(value));
    Ok(P4Connection {
        root: root.to_string_lossy().into_owned(),
        port: first_text(record.get("serverAddress"), &env.port),
        user: first_text(record.get("userName"), &env.user),
        client: first_text(record.get("clientName"), &env.client),
        charset: env.charset.clone(),
        stream: reported_stream.or_else(|| {
            if stream.is_empty() {
                None
            } else {
                Some(stream.to_string())
            }
        }),
        server: record.get("serverVersion").cloned().unwrap_or_default(),
    })
}

fn load_pending(connection: &P4Connection) -> AppResult<Vec<P4Changelist>> {
    let env = env_for(connection);
    let pending_text = run_ok(
        &env,
        &[
            "-ztag",
            "changes",
            "-s",
            "pending",
            "-c",
            &connection.client,
            "-L",
        ],
        None,
    )?;
    let shelved_text = run_ok(
        &env,
        &[
            "-ztag",
            "changes",
            "-s",
            "shelved",
            "-c",
            &connection.client,
        ],
        None,
    )
    .unwrap_or_default();
    let opened_text = run_ok(&env, &["-ztag", "opened"], None)?;
    let mut shelved_ids = BTreeSet::new();
    for record in parse_ztag(&shelved_text) {
        let id = field(&record, "change");
        if !id.is_empty() {
            shelved_ids.insert(id);
        }
    }
    let opened = parse_ztag(&opened_text);
    let depot_files: Vec<String> = opened
        .iter()
        .filter_map(|record| record.get("depotFile").cloned())
        .collect();
    let locals = where_paths(&env, &depot_files);
    let mut by_change: BTreeMap<String, Vec<P4File>> = BTreeMap::new();
    for record in &opened {
        let change = {
            let value = field(record, "change");
            if value.is_empty() {
                "default".to_string()
            } else {
                value
            }
        };
        by_change
            .entry(change)
            .or_default()
            .push(file_from_opened(connection, record, &locals, false));
    }
    for id in shelved_ids.iter().take(40) {
        let Ok(text) = run_ok(&env, &["-ztag", "describe", "-S", "-s", id], None) else {
            continue;
        };
        let record = parse_ztag(&text).into_iter().next().unwrap_or_default();
        let extra = files_from_groups(connection, &indexed_groups(&record), true);
        by_change.entry(id.clone()).or_default().extend(extra);
    }
    let default_description = run_ok(&env, &["change", "-o"], None)
        .map(|spec| read_description(&spec))
        .unwrap_or_default();
    let mut changes = vec![P4Changelist {
        id: "default".to_string(),
        user: connection.user.clone(),
        client: connection.client.clone(),
        status: "pending".to_string(),
        description: default_description,
        time: 0,
        shelved: false,
        files: by_change.remove("default").unwrap_or_default(),
    }];
    let mut numbered = Vec::new();
    for record in parse_ztag(&pending_text) {
        let id = field(&record, "change");
        if id.is_empty() {
            continue;
        }
        let files = by_change.remove(&id).unwrap_or_default();
        let shelved = shelved_ids.contains(&id);
        numbered.push(change_from_record(&record, files, shelved));
    }
    for (id, files) in by_change {
        if numbered.iter().any(|change| change.id == id) {
            continue;
        }
        numbered.push(P4Changelist {
            id: id.clone(),
            user: connection.user.clone(),
            client: connection.client.clone(),
            status: "pending".to_string(),
            description: String::new(),
            time: 0,
            shelved: shelved_ids.contains(&id),
            files,
        });
    }
    numbered.sort_by_key(|change| std::cmp::Reverse(change_number(&change.id)));
    changes.extend(numbered);
    Ok(changes)
}

fn file_from_opened(
    connection: &P4Connection,
    record: &ZtagRecord,
    locals: &BTreeMap<String, String>,
    shelved: bool,
) -> P4File {
    let depot_path = field(record, "depotFile");
    let local_path = locals.get(&depot_path).cloned().unwrap_or_else(|| {
        local_from_client(
            Path::new(&connection.root),
            &connection.client,
            &field(record, "clientFile"),
        )
    });
    P4File {
        depot_path,
        local_path,
        action: field(record, "action"),
        rev: field(record, "rev"),
        shelved,
    }
}

fn files_from_groups(
    connection: &P4Connection,
    groups: &[ZtagRecord],
    shelved: bool,
) -> Vec<P4File> {
    groups
        .iter()
        .filter_map(|group| {
            let depot_path = field(group, "depotFile");
            if depot_path.is_empty() {
                return None;
            }
            Some(P4File {
                local_path: local_from_client(
                    Path::new(&connection.root),
                    &connection.client,
                    &field(group, "clientFile"),
                ),
                depot_path,
                action: field(group, "action"),
                rev: field(group, "rev"),
                shelved,
            })
        })
        .collect()
}

fn change_from_record(record: &ZtagRecord, files: Vec<P4File>, shelved: bool) -> P4Changelist {
    P4Changelist {
        id: field(record, "change"),
        user: field(record, "user"),
        client: field(record, "client"),
        status: {
            let status = field(record, "status");
            if status.is_empty() {
                "submitted".to_string()
            } else {
                status
            }
        },
        description: clean_description(&field(record, "desc")),
        time: field_i64(record, "time"),
        shelved,
        files,
    }
}

fn where_paths(env: &P4Env, files: &[String]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for chunk in files.chunks(80) {
        let mut args = vec!["-ztag".to_string(), "where".into()];
        args.extend(chunk.iter().cloned());
        let Ok(stdout) = run_owned(env, &args, None) else {
            continue;
        };
        for record in parse_ztag(&stdout) {
            if let (Some(depot), Some(path)) = (record.get("depotFile"), record.get("path")) {
                map.insert(depot.clone(), path.clone());
            }
        }
    }
    map
}

fn local_from_client(root: &Path, client: &str, client_file: &str) -> String {
    let prefix = format!("//{client}/");
    let Some(relative) = client_file.strip_prefix(&prefix) else {
        return String::new();
    };
    if relative.is_empty() {
        return root.to_string_lossy().into_owned();
    }
    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
        .to_string_lossy()
        .into_owned()
}

fn history_specs(env: &P4Env, connection: &P4Connection) -> AppResult<Vec<String>> {
    if let Some(stream) = &connection.stream {
        if known_p4_value(stream) {
            return Ok(vec![depot_view(stream)]);
        }
    }
    let spec = run_ok(env, &["client", "-o", &connection.client], None)?;
    let depots = view_depots(&spec);
    if depots.is_empty() {
        Err(AppError::msg(
            "This workspace has no depot view to read history from.",
        ))
    } else {
        Ok(depots)
    }
}

fn p4_connection(start: &Path) -> AppResult<Option<P4Connection>> {
    let config = find_config(start);
    if cli::active_p4().is_none() {
        if config.as_ref().is_some_and(config_is_workspace) {
            return Err(AppError::msg(P4_MISSING));
        }
        return Ok(None);
    }
    let env = match &config {
        Some(config) if config_is_workspace(config) => env_from_config(start, config),
        _ => ambient_env(start),
    };
    match info_connection(start, &env) {
        Ok(found) => Ok(found),
        Err(_) => Ok(config
            .filter(config_is_workspace)
            .map(|config| connection_from_config(&config))),
    }
}

fn info_connection(start: &Path, env: &P4Env) -> AppResult<Option<P4Connection>> {
    let stdout = run_ok(env, &["-ztag", "info"], None)?;
    Ok(connection_from_info(start, env, &stdout))
}

fn connection_from_info(start: &Path, env: &P4Env, stdout: &str) -> Option<P4Connection> {
    let record = parse_ztag(stdout).into_iter().next()?;
    let client = field(&record, "clientName");
    let root = field(&record, "clientRoot");
    if !known_p4_value(&client) || !known_p4_value(&root) {
        return None;
    }
    let root_path = PathBuf::from(strip_verbatim_prefix(&root));
    if !path_is_within(&root_path, start) {
        return None;
    }
    let stream = record
        .get("clientStream")
        .cloned()
        .filter(|value| known_p4_value(value));
    Some(P4Connection {
        root: root_path.to_string_lossy().into_owned(),
        port: first_text(record.get("serverAddress"), &env.port),
        user: first_text(record.get("userName"), &env.user),
        client,
        charset: env.charset.clone(),
        stream,
        server: record.get("serverVersion").cloned().unwrap_or_default(),
    })
}

fn ambient_env(start: &Path) -> P4Env {
    let mut env = P4Env {
        cwd: start.to_path_buf(),
        port: String::new(),
        user: String::new(),
        client: String::new(),
        charset: String::new(),
    };
    if let Ok(text) = run_ok(&env, &["set"], None) {
        let map = parse_p4_set(&text);
        env.port = map.get("P4PORT").cloned().unwrap_or_default();
        env.user = map.get("P4USER").cloned().unwrap_or_default();
        env.client = map.get("P4CLIENT").cloned().unwrap_or_default();
        env.charset = normalize_charset(map.get("P4CHARSET").map(String::as_str).unwrap_or(""));
    }
    env
}

fn env_from_config(start: &Path, config: &ConfigFile) -> P4Env {
    P4Env {
        cwd: start.to_path_buf(),
        port: config.values.get("P4PORT").cloned().unwrap_or_default(),
        user: config.values.get("P4USER").cloned().unwrap_or_default(),
        client: config.values.get("P4CLIENT").cloned().unwrap_or_default(),
        charset: normalize_charset(
            config
                .values
                .get("P4CHARSET")
                .map(String::as_str)
                .unwrap_or(""),
        ),
    }
}

fn connection_from_config(config: &ConfigFile) -> P4Connection {
    P4Connection {
        root: config.directory.to_string_lossy().into_owned(),
        port: config.values.get("P4PORT").cloned().unwrap_or_default(),
        user: config.values.get("P4USER").cloned().unwrap_or_default(),
        client: config.values.get("P4CLIENT").cloned().unwrap_or_default(),
        charset: normalize_charset(
            config
                .values
                .get("P4CHARSET")
                .map(String::as_str)
                .unwrap_or(""),
        ),
        stream: None,
        server: String::new(),
    }
}

fn config_is_workspace(config: &ConfigFile) -> bool {
    config
        .values
        .get("P4PORT")
        .is_some_and(|value| !value.trim().is_empty())
        && config
            .values
            .get("P4CLIENT")
            .is_some_and(|value| !value.trim().is_empty())
}

fn find_config(start: &Path) -> Option<ConfigFile> {
    let names = config_names();
    let mut current = Some(start);
    while let Some(dir) = current {
        for name in &names {
            let file = dir.join(name);
            if !file.is_file() {
                continue;
            }
            if let Some(values) = read_config(&file) {
                return Some(ConfigFile {
                    directory: dir.to_path_buf(),
                    values,
                });
            }
        }
        current = dir.parent();
    }
    None
}

fn config_names() -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(name) = std::env::var("P4CONFIG") {
        let name = name.trim();
        if !name.is_empty() && !name.contains(['/', '\\']) {
            names.push(name.to_string());
        }
    }
    for fallback in [".p4config", "p4config.txt", ".p4config.txt"] {
        if !names.iter().any(|name| name.eq_ignore_ascii_case(fallback)) {
            names.push(fallback.to_string());
        }
    }
    names
}

fn read_config(path: &Path) -> Option<BTreeMap<String, String>> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > 65_536 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    Some(parse_p4config(text))
}

fn git_root(start: &Path) -> AppResult<Option<String>> {
    match crate::git::discover(&start.to_string_lossy()) {
        Ok(repo) => Ok(Some(strip_verbatim_prefix(
            &repo.workdir().to_string_lossy(),
        ))),
        Err(err) if err.to_string() == crate::error::GIT_MISSING => Ok(find_git_dir(start)),
        Err(err) if err.to_string().contains("Bare repositories") => Err(err),
        Err(_) => Ok(None),
    }
}

fn find_git_dir(start: &Path) -> Option<String> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let marker = dir.join(".git");
        if marker.is_dir() || marker.is_file() {
            return Some(dir.to_string_lossy().into_owned());
        }
        current = dir.parent();
    }
    None
}

fn existing_dir(path: &str) -> AppResult<PathBuf> {
    let path = strip_verbatim_prefix(path);
    let start = PathBuf::from(&path);
    if !start.exists() {
        return Err(AppError::msg(format!("Folder not found: {path}")));
    }
    if start.is_file() {
        Ok(start.parent().unwrap_or(&start).to_path_buf())
    } else {
        Ok(start)
    }
}

fn client_exists(env: &P4Env, name: &str) -> AppResult<bool> {
    let stdout = run_ok(env, &["clients", "-e", name], None)?;
    Ok(stdout
        .lines()
        .any(|line| line.split_whitespace().nth(1) == Some(name)))
}

fn write_config(root: &Path, env: &P4Env) -> AppResult<()> {
    update_config_file(root, env)
}

fn update_config_file(root: &Path, env: &P4Env) -> AppResult<()> {
    let names = config_names();
    let path = names
        .iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| {
            root.join(
                names
                    .first()
                    .cloned()
                    .unwrap_or_else(|| ".p4config".to_string()),
            )
        });
    let mut values = if path.is_file() {
        read_config(&path).unwrap_or_default()
    } else {
        BTreeMap::new()
    };
    values.insert("P4PORT".to_string(), env.port.clone());
    values.insert("P4USER".to_string(), env.user.clone());
    values.insert("P4CLIENT".to_string(), env.client.clone());
    if env.charset.is_empty() {
        values.remove("P4CHARSET");
    } else {
        values.insert("P4CHARSET".to_string(), env.charset.clone());
    }
    let mut text = String::new();
    for (key, value) in &values {
        text.push_str(key);
        text.push('=');
        text.push_str(value);
        text.push('\n');
    }
    fs::write(path, text)?;
    Ok(())
}

fn change_spec(env: &P4Env, change_id: &str) -> AppResult<String> {
    if change_id.is_empty() || change_id == "default" || change_id == "new" {
        run_ok(env, &["change", "-o"], None)
    } else {
        run_ok(env, &["change", "-o", change_id], None)
    }
}

fn added_file_diff(path: &str, text: &str) -> FileDiff {
    let mut lines = vec![crate::git::DiffLine {
        kind: "hunk".to_string(),
        content: format!("@@ -0,0 +1,{} @@", text.lines().count()),
        old_lineno: None,
        new_lineno: None,
    }];
    for (index, line) in text.lines().enumerate() {
        if lines.len() >= 4000 {
            return FileDiff {
                path: path.to_string(),
                old_path: None,
                binary: false,
                truncated: true,
                lines,
            };
        }
        lines.push(crate::git::DiffLine {
            kind: "add".to_string(),
            content: line.to_string(),
            old_lineno: None,
            new_lineno: Some((index as u32) + 1),
        });
    }
    FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated: false,
        lines,
    }
}

fn env_for(connection: &P4Connection) -> P4Env {
    P4Env {
        cwd: PathBuf::from(&connection.root),
        port: connection.port.clone(),
        user: connection.user.clone(),
        client: connection.client.clone(),
        charset: connection.charset.clone(),
    }
}

fn run_ok(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<String> {
    cli::run_p4_ok(env, args, input)
}

fn run_owned(env: &P4Env, args: &[String], input: Option<&str>) -> AppResult<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_p4_ok(env, &refs, input)
}

fn require_description(description: &str) -> AppResult<()> {
    if description.trim().is_empty() {
        Err(AppError::msg("Enter a changelist description."))
    } else {
        Ok(())
    }
}

fn optional_name(value: &str) -> AppResult<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(require_name(value)?))
}

fn require_name(value: &str) -> AppResult<String> {
    let value = value.trim();
    if !valid_client_name(value) {
        return Err(AppError::msg(
            "That name is not a Perforce user or workspace.",
        ));
    }
    Ok(value.to_string())
}

fn require_numbered(change_id: &str) -> AppResult<String> {
    let change_id = change_id.trim();
    if change_id.is_empty() || change_id == "default" || change_id.parse::<i64>().is_err() {
        return Err(AppError::msg("Choose a numbered changelist."));
    }
    Ok(change_id.to_string())
}

fn field(record: &ZtagRecord, key: &str) -> String {
    record.get(key).cloned().unwrap_or_default()
}

fn field_i64(record: &ZtagRecord, key: &str) -> i64 {
    record
        .get(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn clean_description(text: &str) -> String {
    let text = text.trim();
    if text == "<enter description here>" {
        String::new()
    } else {
        text.to_string()
    }
}

fn change_number(id: &str) -> i64 {
    id.parse().unwrap_or(0)
}

fn first_text(preferred: Option<&String>, fallback: &str) -> String {
    preferred
        .map(String::as_str)
        .filter(|value| known_p4_value(value))
        .unwrap_or(fallback)
        .to_string()
}
