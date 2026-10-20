//! Perforce workspace commands.
//!
//! A workspace is a client: a server, a user, and a view mapped onto a local
//! root. History lives on the server, so reads go through `p4` rather than a
//! local commit graph.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, P4_LOGIN, P4_MISSING};
use crate::git::{strip_verbatim_prefix, FileDiff};
use crate::p4::cli::{self, P4Env};
use crate::p4::parse::{
    blank_change_spec, classic_client_spec, created_change_id, file_type_is_binary, indexed_groups,
    known_p4_value, normalize_charset, parse_describe_diffs, parse_p4_set, parse_p4config,
    parse_single_diff, parse_ztag, path_depth, path_is_within, read_description, remove_spec_field,
    set_description, set_spec_field, spec_field, sync_estimate_files, sync_reports_a_file,
    valid_client_name, valid_depot_path, ZtagRecord,
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
    pub binary: bool,
    /// Workspace icon state: current, stale, conflict, edit, add, delete, integrate, other, local.
    pub status: String,
    /// Sentence shown in the file tooltip.
    pub detail: String,
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
    /// Oldest change number this page already considered. The next page starts before it.
    pub scanned_through: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4FileSearch {
    pub hits: Vec<P4DirEntry>,
    pub truncated: bool,
    /// Depot search tells the user which path was scanned. Empty for a workspace search.
    pub scope: String,
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
    /// Empty, or current, stale, edit, add, delete, integrate, other, local.
    pub status: String,
    /// Sentence shown when the file icon is hovered.
    pub detail: String,
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
    // Query the changelist index directly: stream filters are not available on
    // every server, and depot-path filters depend on mapped file revisions.
    push_history_range(&mut args, before);
    let stdout = run_owned(&env, &args, None)?;
    let mut changes = Vec::new();
    for record in parse_ztag(&stdout) {
        changes.push(change_from_record(&record, Vec::new(), false));
    }
    let has_more = changes.len() >= limit;
    let scanned_through = changes
        .iter()
        .rev()
        .find_map(|change| change.id.parse::<i64>().ok());
    Ok(P4ChangePage {
        changes,
        has_more,
        scanned_through,
    })
}

pub fn search_submitted(
    connection: &P4Connection,
    user: &str,
    client: &str,
    query: &str,
    before: Option<i64>,
    match_limit: usize,
    scan_limit: usize,
) -> AppResult<P4ChangePage> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return submitted(connection, user, client, match_limit, before);
    }
    let match_limit = match_limit.clamp(1, 100);
    let scan_limit = scan_limit.clamp(1, 2_000);
    let mut matches = Vec::new();
    if before.is_none()
        && needle.chars().all(|ch| ch.is_ascii_digit())
        && needle
            .parse::<i64>()
            .is_ok_and(|id| id.to_string() == needle)
    {
        if let Ok(id) = needle.parse::<i64>() {
            if let Some(change) = exact_submitted(connection, user, client, id)? {
                matches.push(change);
            }
        }
    }
    let mut cursor = before;
    let mut scanned = 0usize;
    let mut has_more = false;
    'pages: loop {
        if matches.len() >= match_limit || scanned >= scan_limit {
            has_more = true;
            break;
        }
        let batch = submitted(connection, user, client, 80, cursor)?;
        if batch.changes.is_empty() {
            break;
        }
        for (index, change) in batch.changes.iter().enumerate() {
            if let Ok(number) = change.id.parse::<i64>() {
                cursor = Some(number);
            }
            scanned += 1;
            if change_matches(change, &needle) && !matches.iter().any(|item| item.id == change.id) {
                matches.push(change.clone());
            }
            if matches.len() >= match_limit || scanned >= scan_limit {
                has_more = index + 1 < batch.changes.len() || batch.has_more;
                break 'pages;
            }
        }
        if !batch.has_more {
            break;
        }
    }
    Ok(P4ChangePage {
        changes: matches,
        has_more,
        scanned_through: cursor,
    })
}

fn change_matches(change: &P4Changelist, needle: &str) -> bool {
    change.id.to_lowercase().contains(needle)
        || change.user.to_lowercase().contains(needle)
        || change.description.to_lowercase().contains(needle)
}

fn exact_submitted(
    connection: &P4Connection,
    user: &str,
    client: &str,
    id: i64,
) -> AppResult<Option<P4Changelist>> {
    if id <= 0 {
        return Ok(None);
    }
    let env = env_for(connection);
    let user = optional_name(user)?;
    let client = optional_name(client)?;
    let mut args = vec![
        "-ztag".to_string(),
        "changes".into(),
        "-s".into(),
        "submitted".into(),
        "-m".into(),
        "1".into(),
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
    args.push(format!("@{id},{id}"));
    let stdout = run_owned(&env, &args, None)?;
    Ok(parse_ztag(&stdout)
        .into_iter()
        .map(|record| change_from_record(&record, Vec::new(), false))
        .find(|change| change.id == id.to_string()))
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
            status: String::new(),
            detail: String::new(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .dir
            .cmp(&left.dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    if entries.iter().any(|entry| !entry.dir) {
        annotate_status(connection, &dir, &mut entries);
    }
    Ok(entries)
}

/// One level of the depot, starting at the depot roots when `path` is empty.
pub fn list_depot(connection: &P4Connection, path: &str) -> AppResult<Vec<P4DirEntry>> {
    let env = env_for(connection);
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || path == "//" {
        let stdout = run_ok(&env, &["-ztag", "depots"], None)?;
        let mut entries = Vec::new();
        for record in parse_ztag(&stdout) {
            let name = field(&record, "name");
            if name.is_empty() || name.contains([' ', '*', '?', '#', '@', '/']) {
                continue;
            }
            entries.push(P4DirEntry {
                name: name.clone(),
                path: format!("//{name}"),
                dir: true,
                status: String::new(),
                detail: String::new(),
            });
        }
        sort_dir_entries(&mut entries);
        return Ok(entries);
    }
    if !valid_depot_path(path) {
        return Err(AppError::msg(
            "Depot path should look like //depot/project.",
        ));
    }
    let spec = format!("{path}/*");
    let mut entries = Vec::new();
    for record in depot_listing(&env, &["-ztag", "dirs", &spec])? {
        let dir = field(&record, "dir");
        if !valid_depot_path(&dir) {
            continue;
        }
        entries.push(P4DirEntry {
            name: depot_base(&dir),
            path: dir,
            dir: true,
            status: String::new(),
            detail: String::new(),
        });
    }
    for record in depot_listing(&env, &["-ztag", "files", &spec])? {
        let file = field(&record, "depotFile");
        if !valid_depot_path(&file) {
            continue;
        }
        entries.push(P4DirEntry {
            name: depot_base(&file),
            path: file,
            dir: false,
            status: String::new(),
            detail: String::new(),
        });
    }
    sort_dir_entries(&mut entries);
    annotate_depot_files(connection, &mut entries);
    Ok(entries)
}

pub fn cancel_depot_search() {
    cli::DEPOT_FILE_SEARCH.cancel();
}

pub fn search_depot(connection: &P4Connection, query: &str) -> AppResult<P4FileSearch> {
    let env = env_for(connection);
    let plan = depot_search_plan(connection, &env, query)?;
    if plan.roots.is_empty() {
        return Ok(P4FileSearch {
            hits: Vec::new(),
            truncated: false,
            scope: plan.scope,
        });
    }
    // `//.../*name*` walks every depot, including engine depots that are not in
    // this stream. Scan the stream (or an explicit //depot prefix) instead, and
    // kill the previous scan when the query changes. Status comes from a later
    // fstat, which would add another round trip on top of the scan.
    let generation = cli::DEPOT_FILE_SEARCH.begin();
    let mut hits = Vec::new();
    let mut seen = BTreeSet::new();
    let mut truncated = false;
    for root in &plan.roots {
        if hits.len() >= DEPOT_SEARCH_LIMIT {
            truncated = true;
            break;
        }
        let remaining = DEPOT_SEARCH_LIMIT - hits.len();
        let spec = format!("{root}/.../*{}*", plan.needle);
        let Some(records) = tracked_depot_files(&env, &spec, remaining, generation)? else {
            return Ok(P4FileSearch {
                hits: Vec::new(),
                truncated: false,
                scope: String::new(),
            });
        };
        for record in records {
            let file = field(&record, "depotFile");
            if !valid_depot_path(&file) || !seen.insert(file.clone()) {
                continue;
            }
            hits.push(P4DirEntry {
                name: depot_base(&file),
                path: file,
                dir: false,
                status: String::new(),
                detail: String::new(),
            });
            if hits.len() >= DEPOT_SEARCH_LIMIT {
                truncated = true;
                break;
            }
        }
    }
    Ok(P4FileSearch {
        hits,
        truncated,
        scope: plan.scope,
    })
}

const DEPOT_SEARCH_LIMIT: usize = 200;

struct DepotSearchPlan {
    roots: Vec<String>,
    needle: String,
    scope: String,
}

fn depot_search_plan(
    connection: &P4Connection,
    env: &P4Env,
    query: &str,
) -> AppResult<DepotSearchPlan> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(DepotSearchPlan {
            roots: Vec::new(),
            needle: String::new(),
            scope: String::new(),
        });
    }
    if query.starts_with("//") || query.contains('/') {
        let Some((root, needle)) = explicit_depot_query(query) else {
            return Ok(DepotSearchPlan {
                roots: Vec::new(),
                needle: String::new(),
                scope: "Use a file name, or //depot/name.".to_string(),
            });
        };
        if needle.chars().count() < 2 {
            return Ok(DepotSearchPlan {
                roots: Vec::new(),
                needle,
                scope: "Type at least 2 characters.".to_string(),
            });
        }
        let scope = format!("In {root}");
        return Ok(DepotSearchPlan {
            roots: vec![root],
            needle,
            scope,
        });
    }
    if !plain_depot_name(query) {
        return Err(AppError::msg(
            "Search with a file name, or a path like //depot/name.",
        ));
    }
    if query.chars().count() < 2 {
        return Ok(DepotSearchPlan {
            roots: Vec::new(),
            needle: query.to_string(),
            scope: "Type at least 2 characters.".to_string(),
        });
    }
    if let Some(stream) = connection
        .stream
        .as_deref()
        .map(str::trim)
        .filter(|stream| valid_depot_path(stream))
    {
        let root = stream.trim_end_matches('/').to_string();
        let scope = format!("In {root}");
        return Ok(DepotSearchPlan {
            roots: vec![root],
            needle: query.to_string(),
            scope,
        });
    }
    let spec = run_ok(env, &["client", "-o", &connection.client], None)?;
    let roots = client_view_roots(&spec);
    if roots.is_empty() {
        return Err(AppError::msg("This workspace has no depot view to search."));
    }
    let scope = if roots.len() == 1 {
        format!("In {}", roots[0])
    } else {
        "In the client view".to_string()
    };
    Ok(DepotSearchPlan {
        roots,
        needle: query.to_string(),
        scope,
    })
}

/// `//depot/dir/name` or `depot/dir/name` searches that directory only.
/// An unfinished path returns `None` so typing does not raise an error.
fn explicit_depot_query(query: &str) -> Option<(String, String)> {
    if !query.starts_with("//") && !query.contains('/') {
        return None;
    }
    let scoped = if query.starts_with("//") {
        query.to_string()
    } else {
        format!("//{query}")
    };
    let path = scoped.trim().trim_end_matches('/');
    let (dir, name) = path.rsplit_once('/')?;
    if !valid_depot_path(dir) || !plain_depot_name(name) {
        return None;
    }
    Some((dir.to_string(), name.to_string()))
}

fn plain_depot_name(name: &str) -> bool {
    !name.is_empty()
        && !name
            .chars()
            .any(|ch| matches!(ch, ' ' | '\\' | '/' | '?' | '#' | '@' | '*' | '\n' | '\r'))
}

fn tracked_depot_files(
    env: &P4Env,
    spec: &str,
    limit: usize,
    generation: u64,
) -> AppResult<Option<Vec<ZtagRecord>>> {
    let limit = limit.to_string();
    match cli::DEPOT_FILE_SEARCH.run(env, &["-ztag", "files", "-m", &limit, spec], generation) {
        Ok(None) => Ok(None),
        Ok(Some(stdout)) => Ok(Some(parse_ztag(&stdout))),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            if message.contains("no such file") || message.contains("no file(s)") {
                Ok(Some(Vec::new()))
            } else if cli::DEPOT_FILE_SEARCH.current() != generation {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn client_view_roots(spec: &str) -> Vec<String> {
    let mut roots = Vec::new();
    let mut in_view = false;
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if !line.starts_with(' ') && !line.starts_with('\t') {
            in_view = trimmed
                .split_once(':')
                .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("View"));
            continue;
        }
        if !in_view || trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let mapping = trimmed.trim_start_matches('+');
        let Some(depot) = mapping.split_whitespace().next() else {
            continue;
        };
        let Some(root) = mapping_root(depot) else {
            continue;
        };
        if roots
            .iter()
            .any(|item: &String| item.eq_ignore_ascii_case(&root))
        {
            continue;
        }
        roots.push(root);
    }
    roots
}

fn mapping_root(depot: &str) -> Option<String> {
    let depot = depot.trim().trim_start_matches('+');
    if !depot.starts_with("//") {
        return None;
    }
    let mut parts = Vec::new();
    for part in depot.trim_start_matches("//").split('/') {
        if part.is_empty() || part == "..." || part.contains(['*', '%']) {
            break;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    let root = format!("//{}", parts.join("/"));
    valid_depot_path(&root).then_some(root)
}

fn depot_listing(env: &P4Env, args: &[&str]) -> AppResult<Vec<ZtagRecord>> {
    match run_ok(env, args, None) {
        Ok(stdout) => Ok(parse_ztag(&stdout)),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            if message.contains("no such file") {
                Ok(Vec::new())
            } else {
                Err(error)
            }
        }
    }
}

fn depot_base(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn sort_dir_entries(entries: &mut [P4DirEntry]) {
    entries.sort_by(|left, right| {
        right
            .dir
            .cmp(&left.dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

fn annotate_depot_files(connection: &P4Connection, entries: &mut [P4DirEntry]) {
    let env = env_for(connection);
    let paths: Vec<String> = entries
        .iter()
        .filter(|entry| !entry.dir)
        .map(|entry| entry.path.clone())
        .collect();
    if paths.is_empty() {
        return;
    }
    let mut known = HashMap::<String, (String, String)>::new();
    for chunk in paths.chunks(40) {
        for record in fstat_records(&env, chunk) {
            let depot = field(&record, "depotFile");
            if depot.is_empty() {
                continue;
            }
            known.insert(depot, status_of(&record));
        }
    }
    for entry in entries.iter_mut() {
        if entry.dir {
            continue;
        }
        let Some((status, detail)) = known.get(&entry.path) else {
            continue;
        };
        entry.status.clone_from(status);
        entry.detail.clone_from(detail);
    }
}

pub fn search_files(connection: &P4Connection, query: &str) -> AppResult<P4FileSearch> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(P4FileSearch {
            hits: Vec::new(),
            truncated: false,
            scope: String::new(),
        });
    }
    let root = PathBuf::from(&connection.root);
    if !root.is_dir() {
        return Err(AppError::msg("Workspace folder was not found."));
    }
    let mut hits = match_workspace_files(&root, &needle);
    let files: Vec<String> = hits
        .iter()
        .filter(|entry| !entry.dir)
        .map(|entry| entry.path.clone())
        .collect();
    let mut annotated = files
        .iter()
        .map(|path| P4DirEntry {
            name: Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.clone(),
            dir: false,
            status: String::new(),
            detail: String::new(),
        })
        .collect::<Vec<_>>();
    annotate_paths(connection, &mut annotated);
    let mut files_done = 0usize;
    for hit in &mut hits {
        if hit.dir {
            continue;
        }
        if let Some(file) = annotated.get(files_done) {
            hit.status.clone_from(&file.status);
            hit.detail.clone_from(&file.detail);
        }
        files_done += 1;
    }
    Ok(P4FileSearch {
        hits,
        truncated: false,
        scope: String::new(),
    })
}

fn match_workspace_files(root: &Path, needle: &str) -> Vec<P4DirEntry> {
    let mut hits = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(root.to_path_buf());
    while let Some(dir) = queue.pop_front() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children = Vec::new();
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            children.push((entry.path(), name, file_type.is_dir()));
        }
        children.sort_by(|left, right| {
            right
                .2
                .cmp(&left.2)
                .then_with(|| generated_dir(&left.1).cmp(&generated_dir(&right.1)))
                .then_with(|| left.1.to_lowercase().cmp(&right.1.to_lowercase()))
        });
        for (path, name, is_dir) in children {
            let matched = name.to_lowercase().contains(needle);
            if is_dir {
                if generated_dir(&name) {
                    if matched {
                        hits.push(plain_dir(&name, &path));
                    }
                    continue;
                }
                if matched {
                    hits.push(plain_dir(&name, &path));
                }
                queue.push_back(path);
                continue;
            }
            if !matched {
                continue;
            }
            hits.push(P4DirEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                dir: false,
                status: String::new(),
                detail: String::new(),
            });
        }
    }
    hits
}

fn plain_dir(name: &str, path: &Path) -> P4DirEntry {
    P4DirEntry {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        dir: true,
        status: String::new(),
        detail: String::new(),
    }
}

fn generated_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "intermediate"
            | "saved"
            | "deriveddatacache"
            | "binaries"
            | ".vs"
            | "library"
    )
}

fn annotate_paths(connection: &P4Connection, files: &mut [P4DirEntry]) {
    if files.is_empty() {
        return;
    }
    let env = env_for(connection);
    let mut known = HashMap::<String, (String, String)>::new();
    let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    for chunk in paths.chunks(40) {
        for record in fstat_records(&env, chunk) {
            let client_file = field(&record, "clientFile");
            if client_file.is_empty() {
                continue;
            }
            known.insert(fold_path(&client_file), status_of(&record));
        }
    }
    if known.is_empty() {
        return;
    }
    for file in files {
        let Some((status, detail)) = known.get(&fold_path(&file.path)) else {
            file.status = "local".to_string();
            file.detail = "Not in the depot".to_string();
            continue;
        };
        file.status.clone_from(status);
        file.detail.clone_from(detail);
    }
}

fn fold_path(path: &str) -> String {
    strip_verbatim_prefix(path)
        .replace('/', "\\")
        .to_lowercase()
}

fn annotate_status(connection: &P4Connection, dir: &Path, entries: &mut [P4DirEntry]) {
    let env = env_for(connection);
    let pattern = dir.join("*").to_string_lossy().into_owned();
    let mut by_name = HashMap::<String, (String, String)>::new();
    for record in fstat_records(&env, &[pattern]) {
        let client_file = field(&record, "clientFile");
        let name = client_file
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_lowercase();
        if name.is_empty() {
            continue;
        }
        by_name.insert(name, status_of(&record));
    }
    if by_name.is_empty() {
        return;
    }
    for entry in entries.iter_mut() {
        if entry.dir {
            continue;
        }
        let Some((status, detail)) = by_name.get(&entry.name.to_lowercase()) else {
            entry.status = "local".to_string();
            entry.detail = "Not in the depot".to_string();
            continue;
        };
        entry.status.clone_from(status);
        entry.detail.clone_from(detail);
    }
}

fn annotate_pending(connection: &P4Connection, changes: &mut [P4Changelist]) {
    let env = env_for(connection);
    let mut paths = Vec::new();
    for change in changes.iter() {
        for file in &change.files {
            if file.depot_path.starts_with("//") {
                paths.push(file.depot_path.clone());
            }
        }
    }
    paths.sort();
    paths.dedup();
    let mut known = HashMap::<String, (String, String)>::new();
    for chunk in paths.chunks(40) {
        for record in fstat_records(&env, chunk) {
            let depot = field(&record, "depotFile");
            if depot.is_empty() {
                continue;
            }
            known.insert(depot, status_of(&record));
        }
    }
    for change in changes.iter_mut() {
        for file in &mut change.files {
            let (status, detail) =
                combine_status(known.get(&file.depot_path).cloned(), &file.action);
            file.status = status;
            file.detail = detail;
        }
    }
}

fn combine_status(fstat: Option<(String, String)>, action: &str) -> (String, String) {
    let fallback = action_status(action);
    let Some((status, detail)) = fstat else {
        return fallback;
    };
    if matches!(status.as_str(), "current" | "local" | "") && !fallback.0.is_empty() {
        return fallback;
    }
    if (status == "stale" || status == "conflict")
        && !fallback.1.is_empty()
        && !detail.contains(fallback.1.as_str())
    {
        return (status, format!("{detail}\n{}", fallback.1));
    }
    (status, detail)
}

fn action_status(action: &str) -> (String, String) {
    let action = action.to_lowercase();
    if action.contains("delete") {
        ("delete".to_string(), "Marked for delete".to_string())
    } else if action.contains("add") {
        ("add".to_string(), "Marked for add".to_string())
    } else if action.contains("edit") {
        ("edit".to_string(), "Checked out for edit".to_string())
    } else if action.contains("integrate") || action.contains("move") || action.contains("branch") {
        ("integrate".to_string(), "Opened for integrate".to_string())
    } else {
        (String::new(), String::new())
    }
}

const FSTAT_FIELDS: &str = "clientFile depotFile haveRev headRev action change ourLock otherOpen otherLock unresolved otherOpen0 otherAction0 otherChange0 otherOpen1 otherAction1 otherChange1 otherOpen2 otherAction2 otherChange2 otherOpen3 otherAction3 otherChange3";
const FSTAT_FIELDS_BASIC: &str =
    "clientFile depotFile haveRev headRev action change otherOpen otherLock unresolved";

fn fstat_records(env: &P4Env, paths: &[String]) -> Vec<ZtagRecord> {
    if paths.is_empty() {
        return Vec::new();
    }
    let stdout = fstat_stdout(env, FSTAT_FIELDS, paths)
        .or_else(|| fstat_stdout(env, FSTAT_FIELDS_BASIC, paths))
        .unwrap_or_default();
    parse_ztag(&stdout)
}

fn fstat_stdout(env: &P4Env, fields: &str, paths: &[String]) -> Option<String> {
    let mut args = vec![
        "-ztag".to_string(),
        "fstat".into(),
        "-T".into(),
        fields.to_string(),
    ];
    args.extend(paths.iter().cloned());
    run_owned(env, &args, None).ok()
}

struct OtherOpen {
    label: String,
    change: String,
    locked: bool,
}

fn status_of(record: &ZtagRecord) -> (String, String) {
    let action = field(record, "action").to_lowercase();
    let have = field(record, "haveRev").parse::<u64>().unwrap_or(0);
    let head = field(record, "headRev").parse::<u64>().unwrap_or(0);
    let others = field(record, "otherOpen").parse::<u64>().unwrap_or(0);
    let openers = other_opens(record);
    let locked = !field(record, "otherLock").is_empty() || openers.iter().any(|item| item.locked);
    let unresolved = record.contains_key("unresolved");
    let ours = action_phrase(&action);
    let (status, headline) = if unresolved {
        ("conflict", "Needs resolve".to_string())
    } else if action.contains("delete") {
        ("delete", "Marked for delete".to_string())
    } else if action.contains("add") {
        ("add", "Marked for add".to_string())
    } else if head > have && head > 0 {
        (
            "stale",
            if have == 0 {
                "Not synced".to_string()
            } else {
                "Not latest".to_string()
            },
        )
    } else if action.contains("edit") {
        ("edit", "Checked out for edit".to_string())
    } else if action.contains("integrate") || action.contains("move") || action.contains("branch") {
        ("integrate", "Opened for integrate".to_string())
    } else if others > 0 || locked || !openers.is_empty() {
        let owner = openers
            .iter()
            .find(|item| item.locked)
            .or_else(|| openers.first());
        let headline = match owner {
            Some(owner) if owner.locked => format!("Locked by {}", owner.label),
            Some(owner) => format!("Opened by {}", owner.label),
            None if locked => "Locked by another user".to_string(),
            None => "Opened by another user".to_string(),
        };
        ("other", headline)
    } else if head > 0 {
        ("current", "Up to date".to_string())
    } else {
        ("local", "Not in the depot".to_string())
    };
    let depot = field(record, "depotFile");
    let mut lines = Vec::new();
    if depot.starts_with("//") {
        lines.push(depot);
    }
    lines.push(headline);
    if let Some(ours) = ours {
        push_line(&mut lines, ours.to_string());
        let change = field(record, "change");
        if !change.is_empty() && change != "default" {
            push_line(&mut lines, format!("Your changelist {change}"));
        }
    }
    for opener in &openers {
        note_opener(&mut lines, opener);
    }
    let named = openers.len() as u64;
    if named > 0 && others > named {
        let extra = others - named;
        let line = if extra == 1 {
            "1 more user has this file open".to_string()
        } else {
            format!("{extra} more users have this file open")
        };
        push_line(&mut lines, line);
    }
    if head > 0 {
        if have == 0 {
            push_line(&mut lines, format!("Head revision {head}"));
        } else if have == head {
            push_line(&mut lines, format!("Revision {have}"));
        } else {
            push_line(&mut lines, format!("Have revision {have}"));
            push_line(&mut lines, format!("Head revision {head}"));
        }
    }
    (status.to_string(), lines.join("\n"))
}

fn action_phrase(action: &str) -> Option<&'static str> {
    if action.contains("delete") {
        Some("Marked for delete")
    } else if action.contains("add") {
        Some("Marked for add")
    } else if action.contains("edit") {
        Some("Checked out for edit")
    } else if action.contains("integrate") || action.contains("move") || action.contains("branch") {
        Some("Opened for integrate")
    } else {
        None
    }
}

fn other_opens(record: &ZtagRecord) -> Vec<OtherOpen> {
    let lock = split_user_client(&field(record, "otherLock"));
    let mut openers = Vec::new();
    for group in indexed_groups(record) {
        let who = field(&group, "otherOpen");
        if who.is_empty() {
            continue;
        }
        let (user, client) = split_user_client(&who);
        if user.is_empty() {
            continue;
        }
        let locked = !lock.0.is_empty()
            && user.eq_ignore_ascii_case(&lock.0)
            && (lock.1.is_empty() || client.eq_ignore_ascii_case(&lock.1));
        openers.push(OtherOpen {
            label: person_label(&user, &client),
            change: field(&group, "otherChange"),
            locked,
        });
    }
    if openers.is_empty() && !lock.0.is_empty() {
        openers.push(OtherOpen {
            label: person_label(&lock.0, &lock.1),
            change: String::new(),
            locked: true,
        });
    }
    openers
}

fn split_user_client(value: &str) -> (String, String) {
    let value = value.split_whitespace().next().unwrap_or("").trim();
    match value.split_once('@') {
        Some((user, client)) => (user.trim().to_string(), client.trim().to_string()),
        None => (value.to_string(), String::new()),
    }
}

fn person_label(user: &str, client: &str) -> String {
    if client.is_empty() {
        user.to_string()
    } else {
        format!("{user} on {client}")
    }
}

fn note_opener(lines: &mut Vec<String>, opener: &OtherOpen) {
    let verb = if opener.locked {
        "Locked by"
    } else {
        "Opened by"
    };
    let short = format!("{verb} {}", opener.label);
    let line = if opener.change.is_empty() || opener.change == "default" {
        short.clone()
    } else {
        format!("{short} in changelist {}", opener.change)
    };
    if let Some(existing) = lines.iter_mut().find(|item| item.as_str() == short) {
        *existing = line;
        return;
    }
    push_line(lines, line);
}

fn push_line(lines: &mut Vec<String>, line: String) {
    if line.is_empty() || lines.iter().any(|item| item == &line) {
        return;
    }
    lines.push(line);
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

pub fn shelve(connection: &P4Connection, change_id: &str, files: &[String]) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    let mut args = vec!["shelve".to_string(), "-f".into(), "-c".into(), id];
    args.extend(files.iter().cloned());
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn unshelve(
    connection: &P4Connection,
    change_id: &str,
    target: Option<&str>,
    files: &[String],
) -> AppResult<()> {
    let source = require_numbered(change_id)?;
    let env = env_for(connection);
    let mut args = vec!["unshelve".to_string(), "-s".into(), source];
    if let Some(target) = target.filter(|target| *target != "default") {
        args.push("-c".into());
        args.push(require_numbered(target)?);
    }
    args.extend(files.iter().cloned());
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn delete_shelf(connection: &P4Connection, change_id: &str) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    run_ok(&env, &["shelve", "-d", "-c", &id], None)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ResolveView {
    pub path: String,
    pub summary: String,
    /// A text merge can accept the merged result. Branch and delete resolves cannot.
    pub content: bool,
    /// False when the two sides could not be diffed. The choices still work.
    pub comparable: bool,
    pub diff: FileDiff,
}

pub fn resolve_view(connection: &P4Connection, path: &str) -> AppResult<P4ResolveView> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg("Choose a file to resolve."));
    }
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "fstat", "-Or", path], None)?;
    let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
    let mut facts = facts_from_fstat(&record, path);
    if facts.from_file.is_empty() {
        let preview = run_ok(&env, &["resolve", "-n", "-o", path], None).unwrap_or_default();
        if let Some(parsed) = parse_resolve_preview(&preview) {
            facts = parsed;
        }
    }
    if facts.from_file.is_empty() && facts.action.is_empty() {
        return Err(AppError::msg("This file does not need resolve."));
    }
    let (diff, comparable) = resolve_diff(&env, &facts);
    Ok(P4ResolveView {
        path: facts.depot.clone(),
        summary: resolve_summary(&facts),
        content: resolve_can_merge(&facts.action, &facts.kind),
        comparable,
        diff,
    })
}

pub fn resolve_accept(connection: &P4Connection, path: &str, mode: &str) -> AppResult<()> {
    let flag = match mode {
        "yours" => "-ay",
        "theirs" => "-at",
        "merge" => "-am",
        _ => return Err(AppError::msg("Choose yours, theirs, or merge.")),
    };
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg("Choose a file to resolve."));
    }
    let env = env_for(connection);
    run_ok(&env, &["resolve", flag, path], None)?;
    if mode == "merge" && resolve_still_open(&env, path)? {
        return Err(AppError::msg(
            "The merge has conflicts. Accept yours or theirs.",
        ));
    }
    Ok(())
}

struct ResolveFacts {
    depot: String,
    action: String,
    kind: String,
    from_file: String,
    start_rev: String,
    end_rev: String,
    base_file: String,
    base_rev: String,
}

fn facts_from_fstat(record: &ZtagRecord, fallback_path: &str) -> ResolveFacts {
    let depot = field(record, "depotFile");
    ResolveFacts {
        depot: if depot.starts_with("//") {
            depot
        } else {
            fallback_path.to_string()
        },
        action: first_field(record, &["resolveAction0", "resolveAction"]),
        kind: first_field(record, &["resolveType0", "resolveType"]),
        from_file: first_field(record, &["resolveFromFile0", "resolveFromFile"]),
        start_rev: first_field(record, &["resolveStartFromRev0", "resolveStartFromRev"]),
        end_rev: first_field(record, &["resolveEndFromRev0", "resolveEndFromRev"]),
        base_file: first_field(record, &["resolveBaseFile0", "resolveBaseFile"]),
        base_rev: first_field(record, &["resolveBaseRev0", "resolveBaseRev"]),
    }
}

fn first_field(record: &ZtagRecord, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| field(record, key))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn parse_resolve_preview(text: &str) -> Option<ResolveFacts> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| line.contains(" - "))?;
    let (path, rest) = line.split_once(" - ")?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let lower = rest.to_lowercase();
    let (action, kind) = if lower.contains("delete") {
        ("delete", "delete")
    } else if lower.contains("branch") || lower.contains("copy") {
        ("branch", "branch")
    } else if lower.contains("move") || lower.contains("rename") {
        ("move", "move")
    } else if lower.contains("filetype") || lower.contains("type change") {
        ("filetype", "filetype")
    } else {
        ("merge", "content")
    };
    let specs = depot_revs(rest);
    let (from_file, start_rev, end_rev) = specs
        .first()
        .cloned()
        .unwrap_or_else(|| (String::new(), String::new(), String::new()));
    let (base_file, _, base_rev) = if lower.contains("using base") {
        specs
            .get(1)
            .cloned()
            .unwrap_or_else(|| (String::new(), String::new(), String::new()))
    } else {
        (String::new(), String::new(), String::new())
    };
    Some(ResolveFacts {
        depot: path.to_string(),
        action: action.to_string(),
        kind: kind.to_string(),
        from_file,
        start_rev,
        end_rev,
        base_file,
        base_rev,
    })
}

fn depot_revs(text: &str) -> Vec<(String, String, String)> {
    let mut specs = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'/' && bytes[index + 1] == b'/' {
            let start = index;
            index += 2;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'#'
            {
                index += 1;
            }
            let file = text[start..index].to_string();
            if index < bytes.len() && bytes[index] == b'#' {
                index += 1;
                let rev_start = index;
                while index < bytes.len() && bytes[index].is_ascii_digit() {
                    index += 1;
                }
                let first = text[rev_start..index].to_string();
                if index + 1 < bytes.len() && bytes[index] == b',' && bytes[index + 1] == b'#' {
                    index += 2;
                    let rev_start = index;
                    while index < bytes.len() && bytes[index].is_ascii_digit() {
                        index += 1;
                    }
                    specs.push((file, first, text[rev_start..index].to_string()));
                } else {
                    specs.push((file, String::new(), first));
                }
            } else if !file.is_empty() {
                specs.push((file, String::new(), String::new()));
            }
        } else {
            index += 1;
        }
    }
    specs
}

fn resolve_summary(facts: &ResolveFacts) -> String {
    let source = revision_span(&facts.from_file, &facts.start_rev, &facts.end_rev);
    if source.is_empty() {
        return "Needs resolve".to_string();
    }
    let action = facts.action.to_lowercase();
    let kind = facts.kind.to_lowercase();
    let verb = if kind.contains("delete") || action == "delete" {
        "Deleting"
    } else if kind.contains("branch") || action == "branch" || action == "copy" {
        "Branching"
    } else if kind.contains("move") || action.contains("move") {
        "Moving"
    } else if kind.contains("filetype") || kind.contains("type") {
        "Changing type from"
    } else {
        "Merging"
    };
    let mut text = format!("{verb} {source}");
    if verb == "Merging" && !facts.base_file.is_empty() {
        text.push_str(" using base ");
        text.push_str(&revision_span(&facts.base_file, "", &facts.base_rev));
    }
    text
}

fn revision_span(file: &str, start: &str, end: &str) -> String {
    if file.is_empty() {
        return String::new();
    }
    if end.is_empty() {
        return if start.is_empty() {
            file.to_string()
        } else {
            format!("{file}#{start}")
        };
    }
    if start.is_empty() || start == end {
        format!("{file}#{end}")
    } else {
        format!("{file}#{start},#{end}")
    }
}

fn resolve_can_merge(action: &str, kind: &str) -> bool {
    let action = action.to_lowercase();
    let kind = kind.to_lowercase();
    if kind.contains("binary") || kind.contains("delete") || action == "delete" {
        return false;
    }
    kind.contains("content") || action == "merge" || action == "edit"
}

fn resolve_diff(env: &P4Env, facts: &ResolveFacts) -> (FileDiff, bool) {
    let depot = facts.depot.clone();
    let end = if facts.end_rev.is_empty() {
        facts.start_rev.clone()
    } else {
        facts.end_rev.clone()
    };
    if !depot.starts_with("//") || facts.from_file.is_empty() || end.is_empty() {
        return (empty_diff(&depot), false);
    }
    let yours = format!("{depot}#have");
    let theirs = format!("{}#{end}", facts.from_file);
    match cli::run_p4_diff(env, &["diff2", "-du", &yours, &theirs]) {
        Ok(text) => (parse_single_diff(&text, &depot), true),
        Err(_) => (empty_diff(&depot), false),
    }
}

fn resolve_still_open(env: &P4Env, path: &str) -> AppResult<bool> {
    match run_ok(env, &["resolve", "-n", path], None) {
        Ok(text) => Ok(text.lines().any(|line| !line.trim().is_empty())),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            if message.contains("no file") {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

fn empty_diff(path: &str) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated: false,
        lines: Vec::new(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4GetRevision {
    pub paths: Vec<String>,
    pub mode: String,
    pub value: String,
    pub force: bool,
    pub safe: bool,
    pub changelist_files_only: bool,
    pub remove_not_in_label: bool,
    pub preview: bool,
}

#[derive(Clone, Copy, Default)]
struct SyncFlags {
    force: bool,
    safe: bool,
    preview: bool,
}

pub fn sync(
    connection: &P4Connection,
    paths: &[String],
    progress: impl FnMut(&str),
) -> AppResult<String> {
    sync_paths(&env_for(connection), paths, SyncFlags::default(), progress)
}

pub fn get_revision(
    connection: &P4Connection,
    request: &P4GetRevision,
    progress: impl FnMut(&str),
) -> AppResult<String> {
    if request.paths.is_empty() {
        return Err(AppError::msg("Choose a file."));
    }
    let env = env_for(connection);
    let (paths, note) = revision_targets(&env, request)?;
    if paths.is_empty() {
        return Ok(if note.is_empty() {
            "Up to date.".to_string()
        } else {
            note
        });
    }
    let mut output = sync_paths(
        &env,
        &paths,
        SyncFlags {
            force: request.force,
            safe: request.safe,
            preview: request.preview,
        },
        progress,
    )?;
    if !note.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&note);
    }
    if output.trim().is_empty() {
        output = "Up to date.".to_string();
    }
    Ok(output)
}

fn revision_targets(env: &P4Env, request: &P4GetRevision) -> AppResult<(Vec<String>, String)> {
    let suffix = revision_suffix(&request.mode, &request.value, request.changelist_files_only)?;
    if request.mode != "label" || request.remove_not_in_label {
        let paths = request
            .paths
            .iter()
            .map(|path| file_at(path, &suffix))
            .collect();
        return Ok((paths, String::new()));
    }
    let label = request.value.trim();
    let mut paths = Vec::new();
    let mut skipped = 0usize;
    for path in &request.paths {
        match file_rev_at_label(env, path, label)? {
            Some(rev) => paths.push(file_at(path, &format!("#{rev}"))),
            None => skipped += 1,
        }
    }
    let note = if skipped == 0 {
        String::new()
    } else if paths.is_empty() {
        "The file is not in that label, so it stays in the workspace.".to_string()
    } else {
        format!("{skipped} files are not in that label and stay in the workspace.")
    };
    Ok((paths, note))
}

fn file_rev_at_label(env: &P4Env, path: &str, label: &str) -> AppResult<Option<String>> {
    let spec = file_at(path, &format!("@{label}"));
    match run_ok(env, &["-ztag", "files", &spec], None) {
        Ok(stdout) => Ok(parse_ztag(&stdout).into_iter().find_map(|record| {
            let rev = field(&record, "rev");
            if rev.is_empty() || !rev.chars().all(|ch| ch.is_ascii_digit()) {
                None
            } else {
                Some(rev)
            }
        })),
        Err(err) => {
            let message = err.to_string();
            if message == P4_LOGIN || !missing_label_file(&message) {
                return Err(err);
            }
            Ok(None)
        }
    }
}

fn missing_label_file(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no such file") || lower.contains("not in label")
}

fn revision_suffix(mode: &str, value: &str, files_only: bool) -> AppResult<String> {
    let value = value.trim();
    match mode {
        "latest" => Ok(String::new()),
        "revision" => {
            let rev = require_revision_number(value, "Enter a revision number.")?;
            Ok(format!("#{rev}"))
        }
        "changelist" => {
            let change = require_revision_number(value, "Enter a changelist number.")?;
            if files_only {
                Ok(format!("@{change},@{change}"))
            } else {
                Ok(format!("@{change}"))
            }
        }
        "datetime" => Ok(format!("@{}", require_p4_datetime(value)?)),
        "label" => {
            if !valid_label(value) {
                return Err(AppError::msg("Enter a label name."));
            }
            Ok(format!("@{value}"))
        }
        "workspace" => {
            if !valid_client_name(value) {
                return Err(AppError::msg("Enter a workspace name."));
            }
            Ok(format!("@{value}"))
        }
        _ => Err(AppError::msg("Choose how to specify the revision.")),
    }
}

fn require_revision_number(value: &str, message: &str) -> AppResult<u64> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(AppError::msg(message.to_string()));
    }
    let number = value
        .parse::<u64>()
        .map_err(|_| AppError::msg(message.to_string()))?;
    if number == 0 {
        return Err(AppError::msg(message.to_string()));
    }
    Ok(number)
}

fn require_p4_datetime(value: &str) -> AppResult<String> {
    if p4_datetime_ok(value) {
        Ok(value.to_string())
    } else {
        Err(AppError::msg(
            "Enter a date as yyyy/mm/dd or yyyy/mm/dd:hh:mm:ss.",
        ))
    }
}

fn p4_datetime_ok(value: &str) -> bool {
    let (date, time) = match value.split_once(':') {
        Some((date, rest)) => (date, Some(rest)),
        None => (value, None),
    };
    let mut parts = date.split('/');
    let year = parts.next();
    let month = parts.next();
    let day = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let Ok(year) = year.parse::<u16>() else {
        return false;
    };
    let Ok(month) = month.parse::<u8>() else {
        return false;
    };
    let Ok(day) = day.parse::<u8>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    let Some(time) = time else {
        return true;
    };
    let mut clock = time.split(':');
    let hour = clock.next();
    let minute = clock.next();
    let second = clock.next();
    if clock.next().is_some() {
        return false;
    }
    let (Some(hour), Some(minute), Some(second)) = (hour, minute, second) else {
        return false;
    };
    if hour.len() != 2 || minute.len() != 2 || second.len() != 2 {
        return false;
    }
    let Ok(hour) = hour.parse::<u8>() else {
        return false;
    };
    let Ok(minute) = minute.parse::<u8>() else {
        return false;
    };
    let Ok(second) = second.parse::<u8>() else {
        return false;
    };
    hour <= 23 && minute <= 59 && second <= 59
}

fn valid_label(name: &str) -> bool {
    (1..=1024).contains(&name.len())
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

fn file_at(path: &str, suffix: &str) -> String {
    if suffix.is_empty() {
        path.to_string()
    } else {
        format!("{}{suffix}", escape_p4_path(path))
    }
}

fn escape_p4_path(path: &str) -> String {
    path.replace('%', "%25")
        .replace('#', "%23")
        .replace('@', "%40")
        .replace('*', "%2A")
}

fn sync_paths(
    env: &P4Env,
    paths: &[String],
    flags: SyncFlags,
    mut progress: impl FnMut(&str),
) -> AppResult<String> {
    if flags.preview {
        progress("Previewing");
        return run_owned(env, &sync_args(paths, false, false, flags), None);
    }
    progress("Counting files");
    let total = run_owned(env, &sync_args(paths, false, true, flags), None)
        .ok()
        .as_deref()
        .and_then(sync_estimate_files);
    if total.is_some_and(|count| count > 0) {
        progress("0% Syncing");
    }
    // P4V transfers several files at once. Four threads is its usual default.
    // Progress is counted from the file lines, because asking p4 for its own
    // progress indicator turns parallel transfer off.
    let mut transferred = 0_u64;
    let mut progress = progress;
    match run_sync(
        env,
        paths,
        true,
        total,
        flags,
        &mut transferred,
        &mut progress,
    ) {
        Err(err) if transferred == 0 && parallel_rejected(&err.to_string()) => run_sync(
            env,
            paths,
            false,
            total,
            flags,
            &mut transferred,
            &mut progress,
        ),
        result => result,
    }
}

fn run_sync(
    env: &P4Env,
    paths: &[String],
    parallel: bool,
    total: Option<u64>,
    flags: SyncFlags,
    transferred: &mut u64,
    progress: &mut dyn FnMut(&str),
) -> AppResult<String> {
    let args = sync_args(paths, parallel, false, flags);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_p4_stream(env, &refs, &mut |line: String| {
        progress(&sync_progress_line(&line, total, transferred));
    })
}

fn sync_progress_line(line: &str, total: Option<u64>, transferred: &mut u64) -> String {
    if sync_reports_a_file(line) {
        *transferred = transferred.saturating_add(1);
        if let Some(total) = total.filter(|count| *count > 0) {
            let percent = (transferred.saturating_mul(100) / total).min(100);
            return format!("{percent}% {line}");
        }
    }
    line.to_string()
}

fn sync_args(paths: &[String], parallel: bool, estimate: bool, flags: SyncFlags) -> Vec<String> {
    let mut args = vec!["sync".to_string()];
    if flags.preview {
        args.push("-n".to_string());
    } else if estimate {
        args.push("-N".to_string());
    } else if parallel {
        args.push("--parallel=threads=4".to_string());
    }
    if flags.force {
        args.push("-f".to_string());
    }
    if flags.safe {
        args.push("-s".to_string());
    }
    args.extend(paths.iter().cloned());
    args
}

fn parallel_rejected(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("parallel")
        && (lower.contains("disable")
            || lower.contains("not enabled")
            || lower.contains("maximum")
            || lower.contains("net.parallel")
            || lower.contains("ignored"))
}

pub fn reconcile(connection: &P4Connection, mut progress: impl FnMut(&str)) -> AppResult<String> {
    let env = env_for(connection);
    cli::run_p4_stream(
        &env,
        &["reconcile", "-e", "-a", "-d"],
        &mut |line: String| {
            progress(&line);
        },
    )
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

pub fn save_workspace(
    connection: &P4Connection,
    root: &str,
    stream: &str,
) -> AppResult<P4Connection> {
    let root_path = PathBuf::from(strip_verbatim_prefix(root.trim()));
    if !root_path.is_absolute() {
        return Err(AppError::msg(
            "Choose an absolute folder for the workspace.",
        ));
    }
    let stream = stream.trim();
    if !stream.is_empty() && !valid_depot_path(stream) {
        return Err(AppError::msg("Stream should look like //depot/main."));
    }
    fs::create_dir_all(&root_path)?;
    let mut env = env_for(connection);
    let current = run_ok(&env, &["client", "-o", &connection.client], None)?;
    let current_stream = spec_field(&current, "Stream");
    let mut spec = if !stream.is_empty() && stream != current_stream {
        run_ok(
            &env,
            &["client", "-S", stream, "-o", &connection.client],
            None,
        )?
    } else if stream.is_empty() && !current_stream.is_empty() {
        remove_spec_field(&current, "Stream")
    } else {
        current
    };
    spec = set_spec_field(&spec, "Root", &root_path.to_string_lossy());
    run_ok(&env, &["client", "-i"], Some(&spec))?;
    env.cwd = root_path.clone();
    update_config_file(&root_path, &env)?;
    connection_after_create(&env, &root_path, stream)
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
    annotate_pending(connection, &mut changes);
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
        binary: file_type_is_binary(&field(record, "type")),
        status: String::new(),
        detail: String::new(),
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
                binary: file_type_is_binary(&field(group, "type")),
                status: String::new(),
                detail: String::new(),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Location {
    pub depot: String,
    pub local: String,
}

/// Map a workspace or depot path to the other side of the client view.
pub fn locate(connection: &P4Connection, path: &str) -> AppResult<P4Location> {
    let spec = path.trim().trim_end_matches(['/', '\\']);
    if spec.is_empty() || spec == "//" {
        return Err(AppError::msg("Choose a file or folder."));
    }
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "where", spec], None)?;
    let wanted = normalize_location(spec);
    let mut fallback = None;
    for record in parse_ztag(&stdout) {
        if record.contains_key("unmap") {
            continue;
        }
        let depot = mapped_location(&field(&record, "depotFile"));
        let local = mapped_location(&field(&record, "path"));
        if depot.is_empty() || local.is_empty() {
            continue;
        }
        let location = P4Location { depot, local };
        if same_location(&location.depot, &wanted) || same_location(&location.local, &wanted) {
            return Ok(location);
        }
        if fallback.is_none() {
            fallback = Some(location);
        }
    }
    fallback.ok_or_else(|| AppError::msg("That path is not in this workspace."))
}

fn mapped_location(value: &str) -> String {
    let value = value.trim().trim_end_matches(['/', '\\']);
    let value = value.strip_suffix("...").unwrap_or(value);
    value.trim_end_matches(['/', '\\']).to_string()
}

fn normalize_location(value: &str) -> String {
    mapped_location(value).replace('\\', "/").to_ascii_lowercase()
}

fn same_location(left: &str, right: &str) -> bool {
    normalize_location(left) == right || normalize_location(left) == normalize_location(right)
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

fn push_history_range(args: &mut Vec<String>, before: Option<i64>) {
    if let Some(change) = before.filter(|change| *change > 1) {
        args.push(format!("@1,@{}", change - 1));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pairs: &[(&str, &str)]) -> ZtagRecord {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn other_open_names_the_user_and_puts_each_fact_on_its_own_line() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "3"),
            ("otherOpen", "1"),
            ("otherOpen0", "alice@dev-pc"),
            ("otherAction0", "edit"),
            ("otherChange0", "44"),
        ]));
        assert_eq!(status, "other");
        assert_eq!(
            detail,
            "Opened by alice on dev-pc in changelist 44\nRevision 3"
        );
    }

    #[test]
    fn a_lock_names_the_user_when_no_open_record_is_present() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "3"),
            ("otherOpen", "1"),
            ("otherLock", "alice@dev-pc"),
        ]));
        assert_eq!(status, "other");
        assert_eq!(
            detail,
            "Locked by alice on dev-pc\nRevision 3"
        );
    }

    #[test]
    fn stale_checkout_splits_status_changelist_and_revisions() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "8"),
            ("action", "edit"),
            ("change", "42"),
        ]));
        assert_eq!(status, "stale");
        assert_eq!(
            detail,
            "Not latest\nChecked out for edit\nYour changelist 42\nHave revision 3\nHead revision 8"
        );
    }

    #[test]
    fn your_changelist_is_not_the_same_line_as_someone_elses() {
        let (status, detail) = status_of(&record(&[
            ("depotFile", "//depot/main/settings.ini"),
            ("haveRev", "39"),
            ("headRev", "39"),
            ("action", "edit"),
            ("change", "42"),
            ("otherOpen", "2"),
            ("otherOpen0", "alice@dev-pc"),
            ("otherAction0", "edit"),
            ("otherChange0", "43"),
            ("otherOpen1", "bob@build-pc"),
            ("otherAction1", "edit"),
            ("otherChange1", "43"),
        ]));
        assert_eq!(status, "edit");
        assert_eq!(
            detail,
            "\
//depot/main/settings.ini
Checked out for edit
Your changelist 42
Opened by alice on dev-pc in changelist 43
Opened by bob on build-pc in changelist 43
Revision 39"
        );
    }

    #[test]
    fn an_unnamed_open_still_splits_the_revision() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "3"),
            ("otherOpen", "1"),
        ]));
        assert_eq!(status, "other");
        assert_eq!(detail, "Opened by another user\nRevision 3");
    }

    #[test]
    fn depot_search_scopes_to_an_explicit_path() {
        let (root, needle) = explicit_depot_query("//vendor/library/settings").unwrap();
        assert_eq!(root, "//vendor/library");
        assert_eq!(needle, "settings");
        let (root, needle) = explicit_depot_query("depot/Player").unwrap();
        assert_eq!(root, "//depot");
        assert_eq!(needle, "Player");
        assert!(explicit_depot_query("Player").is_none());
        assert!(explicit_depot_query("//vendor").is_none());
    }

    #[test]
    fn client_view_roots_keep_the_depot_side_and_skip_exclusions() {
        let spec = "\
Client:\tpc

View:
\t//depot/... //pc/...
\t-//depot/Saved/... //pc/Saved/...
\t+//vendor/library/... //pc/library/...
\t//... //pc/everything/...

Description:
\tCreated by Rebasely.
";
        assert_eq!(
            client_view_roots(spec),
            vec![
                "//depot".to_string(),
                "//vendor/library".to_string(),
            ]
        );
    }

    #[test]
    fn depot_path_is_the_first_status_line() {
        let (status, detail) = status_of(&record(&[
            ("depotFile", "//depot/main/notes.bat"),
            ("haveRev", "1"),
            ("headRev", "1"),
        ]));
        assert_eq!(status, "current");
        assert_eq!(
            detail,
            "//depot/main/notes.bat\nUp to date\nRevision 1"
        );
    }

    #[test]
    fn revision_specifiers_match_the_get_revision_dialog() {
        assert_eq!(revision_suffix("latest", "", false).unwrap(), "");
        assert_eq!(revision_suffix("revision", "12", false).unwrap(), "#12");
        assert_eq!(
            revision_suffix("changelist", "1200", false).unwrap(),
            "@1200"
        );
        assert_eq!(
            revision_suffix("changelist", "1200", true).unwrap(),
            "@1200,@1200"
        );
        assert_eq!(
            revision_suffix("datetime", "2026/10/16:14:30:00", false).unwrap(),
            "@2026/10/16:14:30:00"
        );
        assert_eq!(
            revision_suffix("datetime", "2026/10/16", false).unwrap(),
            "@2026/10/16"
        );
        assert_eq!(
            revision_suffix("label", "rel-1.0", false).unwrap(),
            "@rel-1.0"
        );
        assert_eq!(
            revision_suffix("workspace", "dev-workspace", false).unwrap(),
            "@dev-workspace"
        );
        assert!(revision_suffix("revision", "0", false).is_err());
        assert!(revision_suffix("datetime", "2026-10-16", false).is_err());
        assert!(revision_suffix("label", "bad label", false).is_err());
        assert_eq!(file_at(r"C:\work\a#b.txt", "#3"), r"C:\work\a%23b.txt#3");
    }

    #[test]
    fn description_search_matches_text_outside_the_loaded_page() {
        let change = P4Changelist {
            id: "900".to_string(),
            user: "alice".to_string(),
            client: "alice_main".to_string(),
            status: "submitted".to_string(),
            description: "Fix the stream switch".to_string(),
            time: 0,
            shelved: false,
            files: Vec::new(),
        };
        assert!(change_matches(&change, "stream"));
        assert!(change_matches(&change, "900"));
        assert!(!change_matches(&change, "missing"));
    }

    #[test]
    fn workspace_search_keeps_hierarchy_and_skips_generated_trees() {
        let root = std::env::temp_dir().join(format!(
            "rebasely-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("client").join("src")).unwrap();
        fs::write(
            root.join("client")
                .join("src")
                .join("notes.bat"),
            b"@echo off",
        )
        .unwrap();
        fs::create_dir_all(root.join("Intermediate").join("deep")).unwrap();
        fs::write(
            root.join("Intermediate").join("deep").join("secret.txt"),
            b"x",
        )
        .unwrap();
        fs::create_dir_all(root.join(".cache")).unwrap();

        let hits = match_workspace_files(&root, "notes");
        assert!(hits
            .iter()
            .any(|hit| !hit.dir && hit.name == "notes.bat"));
        assert!(hits.iter().all(|hit| !hit.path.contains("secret.txt")));

        let folders = match_workspace_files(&root, "cache");
        assert!(folders
            .iter()
            .any(|hit| hit.dir && hit.name.eq_ignore_ascii_case(".cache")));

        let generated = match_workspace_files(&root, "secret");
        assert!(generated.is_empty());
        let named = match_workspace_files(&root, "intermediate");
        assert!(named
            .iter()
            .any(|hit| hit.dir && hit.name.eq_ignore_ascii_case("Intermediate")));
        assert!(named.iter().all(|hit| hit.dir));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn history_paging_is_a_changelist_range() {
        let mut args = Vec::new();
        push_history_range(&mut args, None);
        assert!(args.is_empty());
        push_history_range(&mut args, Some(1));
        assert!(args.is_empty());
        push_history_range(&mut args, Some(1200));
        assert_eq!(args, vec!["@1,@1199".to_string()]);
    }

    #[test]
    fn resolve_summary_names_the_source_and_base() {
        let facts = facts_from_fstat(
            &record(&[
                ("depotFile", "//depot/main/app.ini"),
                ("resolveAction0", "merge"),
                ("resolveType0", "content"),
                ("resolveFromFile0", "//depot/dev/app.ini"),
                ("resolveStartFromRev0", "4"),
                ("resolveEndFromRev0", "7"),
                ("resolveBaseFile0", "//depot/dev/app.ini"),
                ("resolveBaseRev0", "3"),
            ]),
            "//depot/main/app.ini",
        );
        assert!(resolve_can_merge(&facts.action, &facts.kind));
        assert_eq!(
            resolve_summary(&facts),
            "Merging //depot/dev/app.ini#4,#7 using base //depot/dev/app.ini#3"
        );
    }

    #[test]
    fn a_delete_resolve_cannot_merge() {
        let facts =
            parse_resolve_preview("//depot/main/Old.ini - delete from //depot/dev/Old.ini#1,#2")
                .unwrap();
        assert_eq!(facts.action, "delete");
        assert!(!resolve_can_merge(&facts.action, &facts.kind));
        assert_eq!(resolve_summary(&facts), "Deleting //depot/dev/Old.ini#1,#2");
    }
}
