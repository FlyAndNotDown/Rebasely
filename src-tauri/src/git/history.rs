use super::*;

pub(super) fn summarize_oid(repo: &Repository, oid: &str) -> AppResult<CommitSummary> {
    Ok(summary_from_info(&commit_info(repo, oid)?))
}

pub(super) fn summary_from_info(info: &CommitInfo) -> CommitSummary {
    CommitSummary {
        id: info.id.clone(),
        short_id: short_id(&info.id),
        summary: info.summary.clone(),
        body: info.body.clone(),
        author_name: info.author_name.clone(),
        author_email: info.author_email.clone(),
        timestamp: info.timestamp,
        parents: info.parents.clone(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
        path: None,
    }
}

pub fn commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: Option<&str>,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let revs = normalize_revs(revs);
    if let Some(query) = query {
        return search_commits(repo, limit, skip, query, &revs);
    }
    let root = workdir(repo)?;
    // Committer-date order, unlike author-date order, lets git stream from
    // the commit-graph instead of sorting all of history first.
    let args = git_log_args(
        &revs,
        &["-c", "log.showSignature=false", "log", "--date-order"],
    );
    let warming = if skip == 0 {
        warm_reachable(repo)
    } else {
        Vec::new()
    };
    let page = log_page(root, &args, skip, limit);
    for handle in warming {
        let _ = handle.join();
    }
    let mut items = parse_git_log(&page?)?;
    decorate_commits(repo, &mut items);
    Ok(items)
}

pub(super) fn normalize_revs(revs: &[String]) -> Vec<String> {
    revs.iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect()
}

pub(super) fn push_all_branch_tips(args: &mut Vec<String>) {
    if let Some(index) = args.iter().position(|arg| arg == "log") {
        args.insert(index + 1, "--branches".to_string());
        args.insert(index + 2, "--remotes".to_string());
    } else {
        args.push("--branches".to_string());
        args.push("--remotes".to_string());
    }
}

pub(super) fn git_log_args(revs: &[String], prefix: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = prefix.iter().map(|value| (*value).to_string()).collect();
    if revs.is_empty() {
        push_all_branch_tips(&mut args);
    }
    args.push("--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P".to_string());
    args.extend(revs.iter().cloned());
    args
}

/// A history search split into filters git applies and free text matched here.
#[derive(Debug, Default, PartialEq)]
pub(super) struct SearchQuery {
    pub text: String,
    pub authors: Vec<String>,
    pub paths: Vec<String>,
    /// `-S`: commits that add or remove this text.
    pub content: Option<String>,
    /// `-G`: commits whose diff has a line matching this regex.
    pub regex: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

/// Splits on whitespace, keeping double-quoted runs together without the quotes.
fn search_tokens(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for char in query.chars() {
        match char {
            '"' => quoted = !quoted,
            char if char.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            char => current.push(char),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

pub(super) fn parse_search_query(query: &str) -> SearchQuery {
    let mut parsed = SearchQuery::default();
    let mut text = Vec::new();
    for token in search_tokens(query) {
        let Some((key, value)) = token.split_once(':') else {
            text.push(token);
            continue;
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            text.push(token);
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "author" => parsed.authors.push(value),
            "path" | "file" => parsed.paths.push(value.replace('\\', "/")),
            "content" => parsed.content = Some(value),
            "regex" => parsed.regex = Some(value),
            "since" | "after" => parsed.since = Some(value),
            "until" | "before" => parsed.until = Some(value),
            _ => text.push(token),
        }
    }
    parsed.text = text.join(" ");
    parsed
}

pub(super) fn git_search_log_args(revs: &[String], query: &SearchQuery) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "log.showSignature=false".to_string(),
        "-c".to_string(),
        "i18n.logOutputEncoding=utf-8".to_string(),
        "log".to_string(),
        "--date-order".to_string(),
    ];
    if revs.is_empty() {
        args.push("--branches".to_string());
        args.push("--remotes".to_string());
    }
    if !query.authors.is_empty() {
        args.extend([
            "--regexp-ignore-case".to_string(),
            "--fixed-strings".to_string(),
        ]);
        args.extend(
            query
                .authors
                .iter()
                .map(|author| format!("--author={author}")),
        );
    }
    if let Some(content) = &query.content {
        args.push(format!("-S{content}"));
    }
    if let Some(regex) = &query.regex {
        args.push(format!("-G{regex}"));
    }
    if let Some(since) = &query.since {
        args.push(format!("--since={since}"));
    }
    if let Some(until) = &query.until {
        args.push(format!("--until={until}"));
    }
    args.push("--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P".to_string());
    args.extend(revs.iter().cloned());
    if !query.paths.is_empty() {
        args.push("--".to_string());
        args.extend(query.paths.iter().cloned());
    }
    args
}

pub(super) fn search_commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: &str,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let parsed = parse_search_query(query);
    let needle = parsed.text.to_lowercase();
    let labels = collect_ref_labels(repo);
    let mut items = Vec::new();
    let mut skipped = 0usize;

    if let Ok(root) = workdir(repo) {
        let args = git_search_log_args(revs, &parsed);
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut child = spawn_git_stdout(root, &argv)?;
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut record = Vec::new();
            while read_git_line(&mut reader, &mut record)? {
                let Some(commit) = parse_search_record(&record) else {
                    continue;
                };
                if !commit_matches(&commit, &needle, &labels) {
                    continue;
                }
                if skipped < skip {
                    skipped += 1;
                    continue;
                }
                items.push(commit);
                if items.len() >= limit {
                    break;
                }
            }
        }
        stop_child(&mut child);
    }

    apply_ref_labels(&mut items, &labels);
    mark_on_current_branch(repo, &mut items);
    Ok(items)
}

pub(super) fn parse_search_record(bytes: &[u8]) -> Option<CommitSummary> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0');
    let id = normalize_oid(fields.next()?)?;
    let short_id = fields.next()?.trim().to_string();
    let summary = fields.next()?.to_string();
    let author_name = fields.next()?.trim().to_string();
    let author_email = fields.next()?.trim().to_string();
    let timestamp = fields.next()?.trim().parse().unwrap_or(0);
    let parents = fields.next().unwrap_or("");
    if short_id.is_empty() {
        return None;
    }
    Some(CommitSummary {
        id,
        short_id,
        summary,
        body: String::new(),
        author_name,
        author_email,
        timestamp,
        parents: parents
            .split_whitespace()
            .filter_map(normalize_oid)
            .collect(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
        path: None,
    })
}

pub(super) fn normalize_oid(value: &str) -> Option<String> {
    let value = value.trim();
    let len = value.len();
    if (4..=40).contains(&len) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(value.to_string())
    } else {
        None
    }
}

pub(super) fn commit_matches(
    commit: &CommitSummary,
    needle: &str,
    labels: &HashMap<String, Vec<CommitRefLabel>>,
) -> bool {
    if needle.is_empty() {
        return true;
    }
    let hash = commit.id.to_lowercase();
    if hash.starts_with(needle) || commit.short_id.to_lowercase().starts_with(needle) {
        return true;
    }
    if commit.summary.to_lowercase().contains(needle)
        || commit.body.to_lowercase().contains(needle)
        || commit.author_name.to_lowercase().contains(needle)
        || commit.author_email.to_lowercase().contains(needle)
    {
        return true;
    }
    labels.get(&commit.id).is_some_and(|refs| {
        refs.iter()
            .any(|label| label.name.to_lowercase().contains(needle))
    })
}

pub(super) fn parse_git_log(bytes: &[u8]) -> AppResult<Vec<CommitSummary>> {
    let text = String::from_utf8_lossy(bytes);
    let mut items = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\0');
        let Some(id) = fields.next() else { continue };
        let Some(short_id) = fields.next() else {
            continue;
        };
        let Some(summary) = fields.next() else {
            continue;
        };
        let Some(author_name) = fields.next() else {
            continue;
        };
        let Some(author_email) = fields.next() else {
            continue;
        };
        let Some(timestamp) = fields.next() else {
            continue;
        };
        let parents = fields.next().unwrap_or("");
        items.push(CommitSummary {
            id: id.to_string(),
            short_id: short_id.to_string(),
            summary: summary.to_string(),
            body: String::new(),
            author_name: author_name.to_string(),
            author_email: author_email.to_string(),
            timestamp: timestamp.parse().unwrap_or(0),
            parents: if parents.is_empty() {
                Vec::new()
            } else {
                parents.split_whitespace().map(str::to_string).collect()
            },
            refs: Vec::new(),
            on_current_branch: true,
            on_tracking_branch: false,
            path: None,
        });
    }
    Ok(items)
}

pub(super) fn decorate_commits(repo: &Repository, commits: &mut [CommitSummary]) {
    let labels = collect_ref_labels(repo);
    apply_ref_labels(commits, &labels);
    mark_on_current_branch(repo, commits);
}

pub(super) fn mark_on_current_branch(repo: &Repository, commits: &mut [CommitSummary]) {
    let head = head_oid(repo);
    let upstream = if symbolic_branch(repo).is_some() {
        rev_parse(repo, "@{upstream}")
    } else {
        None
    };
    let on_head = head.as_ref().and_then(|id| reachable_commits(repo, id));
    let on_upstream = upstream.as_ref().and_then(|id| reachable_commits(repo, id));
    let head_too_big = head.is_some() && on_head.is_none();
    let upstream_too_big = upstream.is_some() && on_upstream.is_none();
    for commit in commits.iter_mut() {
        commit.on_current_branch = if head_too_big {
            is_ancestor(repo, &commit.id, head.as_deref())
        } else {
            on_head.as_ref().is_some_and(|set| set.contains(&commit.id))
        };
        commit.on_tracking_branch = if upstream_too_big {
            is_ancestor(repo, &commit.id, upstream.as_deref())
        } else {
            on_upstream
                .as_ref()
                .is_some_and(|set| set.contains(&commit.id))
        };
    }
}

/// `git rev-list` already reads the commit-graph. The walk starts while `git log`
/// is still running so the two overlap.
fn warm_reachable(repo: &Repository) -> Vec<thread::JoinHandle<()>> {
    let mut tips = Vec::new();
    if let Some(head) = head_oid(repo) {
        tips.push(head);
    }
    if symbolic_branch(repo).is_some() {
        if let Some(upstream) = rev_parse(repo, "@{upstream}") {
            if !tips.contains(&upstream) {
                tips.push(upstream);
            }
        }
    }
    tips.into_iter()
        .map(|tip| {
            let repo = repo.clone();
            thread::spawn(move || {
                let _ = reachable_commits(&repo, &tip);
            })
        })
        .collect()
}

pub(super) fn reachable_commits(repo: &Repository, tip: &str) -> Option<Arc<HashSet<String>>> {
    #[derive(PartialEq)]
    struct Key {
        root: PathBuf,
        tip: String,
        shallow: Option<Vec<u8>>,
    }

    enum Cached {
        Set(Arc<HashSet<String>>),
        TooBig,
    }
    const MAX_REACHABLE: usize = 2_000_000;
    const MAX_SHALLOW_KEY_BYTES: u64 = 64 * 1024;
    // A shallow boundary can change without moving the tip when fetching more
    // history. Include its bytes, but avoid allocating an unbounded cache key.
    let shallow = match fs::File::open(repo.commondir().join("shallow")) {
        Ok(file) => {
            let mut bytes = Vec::new();
            if file
                .take(MAX_SHALLOW_KEY_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_SHALLOW_KEY_BYTES
            {
                return walk_reachable(repo, tip, MAX_REACHABLE).map(Arc::new);
            }
            Some(bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return walk_reachable(repo, tip, MAX_REACHABLE).map(Arc::new),
    };
    let key = Key {
        root: repo.commondir().to_path_buf(),
        tip: tip.to_string(),
        shallow,
    };
    static CACHE: OnceLock<Mutex<Vec<(Key, Cached)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((_, cached)) = guard.iter().find(|(entry, _)| entry == &key) {
            return match cached {
                Cached::Set(set) => Some(Arc::clone(set)),
                Cached::TooBig => None,
            };
        }
    }

    let cached = match walk_reachable(repo, tip, MAX_REACHABLE) {
        Some(set) => Cached::Set(Arc::new(set)),
        None => Cached::TooBig,
    };
    let result = match &cached {
        Cached::Set(set) => Some(Arc::clone(set)),
        Cached::TooBig => None,
    };
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|(entry, _)| entry != &key);
        guard.push((key, cached));
        if guard.len() > 4 {
            let extra = guard.len() - 4;
            guard.drain(0..extra);
        }
    }
    result
}

pub(super) fn walk_reachable(
    repo: &Repository,
    tip: &str,
    limit: usize,
) -> Option<HashSet<String>> {
    let mut child = spawn_git_stdout(repo.workdir(), &["rev-list", tip]).ok()?;
    let result = (|| {
        let mut reader = BufReader::new(child.stdout.take()?);
        let mut line = Vec::new();
        let mut set = HashSet::new();
        while read_git_line(&mut reader, &mut line).ok()? {
            let text = String::from_utf8_lossy(&line);
            let id = text.trim();
            if id.is_empty() {
                continue;
            }
            set.insert(id.to_string());
            if set.len() > limit {
                return None;
            }
        }
        if set.is_empty() {
            None
        } else {
            Some(set)
        }
    })();
    if result.is_none() {
        stop_child(&mut child);
        return None;
    }
    match child.wait() {
        Ok(status) if status.success() => result,
        Ok(_) => None,
        Err(_) => {
            stop_child(&mut child);
            None
        }
    }
}

fn is_ancestor(repo: &Repository, commit: &str, tip: Option<&str>) -> bool {
    let Some(tip) = tip else {
        return false;
    };
    if commit == tip {
        return true;
    }
    run_git(
        repo.workdir(),
        &["merge-base", "--is-ancestor", commit, tip],
    )
    .ok()
    .is_some_and(|output| output.status.success())
}

pub(super) fn apply_ref_labels(
    commits: &mut [CommitSummary],
    labels: &HashMap<String, Vec<CommitRefLabel>>,
) {
    for commit in commits {
        if let Some(mut refs) = labels.get(&commit.id).cloned() {
            refs.sort_by(|left, right| {
                ref_kind_rank(&left.kind)
                    .cmp(&ref_kind_rank(&right.kind))
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            });
            commit.refs = refs;
        }
    }
}

pub(super) fn ref_kind_rank(kind: &str) -> u8 {
    match kind {
        "head" => 0,
        "branch" => 1,
        "tag" => 2,
        _ => 3,
    }
}

pub(super) fn collect_ref_labels(repo: &Repository) -> HashMap<String, Vec<CommitRefLabel>> {
    let mut labels: HashMap<String, Vec<CommitRefLabel>> = HashMap::new();
    let remote_names = configured_remote_names(repo);
    if let Ok(root) = workdir(repo) {
        if let Ok(stdout) = run_git_stdout(
            root,
            &[
                "for-each-ref",
                "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%00%(refname)%00%(HEAD)",
                "refs/heads",
                "refs/tags",
                "refs/remotes",
            ],
        ) {
            let text = String::from_utf8_lossy(&stdout);
            for line in text.split('\n') {
                if line.is_empty() {
                    continue;
                }
                let mut fields = line.split('\0');
                let Some(oid) = fields.next() else { continue };
                let Some(refname) = fields.next() else { continue };
                let (kind, name) = if let Some(name) = refname.strip_prefix("refs/heads/") {
                    ("branch", name)
                } else if let Some(name) = refname.strip_prefix("refs/tags/") {
                    ("tag", name)
                } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
                    if !is_remote_branch_name(name, &remote_names) {
                        continue;
                    }
                    ("branch", name)
                } else {
                    continue;
                };
                if name.is_empty() {
                    continue;
                }
                labels.entry(oid.to_string()).or_default().push(CommitRefLabel {
                    name: name.to_string(),
                    kind: kind.to_string(),
                });
            }
        }
    }

    if let Some(oid) = head_oid(repo) {
        let entry = labels.entry(oid).or_default();
        if !entry.iter().any(|label| label.kind == "head") {
            entry.insert(
                0,
                CommitRefLabel {
                    name: "HEAD".to_string(),
                    kind: "head".to_string(),
                },
            );
        }
    }
    labels
}

pub fn file_commits(
    repo: &Repository,
    path: &str,
    limit: usize,
    skip: usize,
) -> AppResult<Vec<CommitSummary>> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    let root = workdir(repo)?;
    // `--follow` switches to the old name only when it prints the rename, so a
    // `--skip` past the rename would lose everything older. Read through instead.
    let count = format!("-n{}", skip + limit.max(1));
    let stdout = run_git_stdout(
        root,
        &[
            "-c",
            "log.showSignature=false",
            "-c",
            "core.quotePath=off",
            "log",
            "--follow",
            "--name-status",
            "-z",
            "--format=%x1e%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P",
            &count,
            "HEAD",
            "--",
            &rel,
        ],
    )?;
    Ok(parse_follow_log(&stdout, &rel)
        .into_iter()
        .skip(skip)
        .collect())
}

/// Parses `git log --follow --name-status -z` records. Each commit carries the
/// file's name at that commit so its diff can be shown after a rename.
pub(super) fn parse_follow_log(bytes: &[u8], current: &str) -> Vec<CommitSummary> {
    let text = String::from_utf8_lossy(bytes);
    let mut items = Vec::new();
    let mut fallback = current.to_string();
    for record in text.split('\u{1e}') {
        let fields: Vec<&str> = record.split('\0').collect();
        if fields.len() < 7 {
            continue;
        }
        let Some(id) = normalize_oid(fields[0]) else {
            continue;
        };
        let status: Vec<&str> = fields[7..]
            .iter()
            .map(|field| field.trim_start_matches('\n'))
            .filter(|field| !field.is_empty())
            .collect();
        let path = match status.as_slice() {
            [kind, old, new, ..] if kind.starts_with('R') || kind.starts_with('C') => {
                let path = new.replace('\\', "/");
                fallback = old.replace('\\', "/");
                path
            }
            [_, path, ..] => {
                let path = path.replace('\\', "/");
                fallback = path.clone();
                path
            }
            _ => fallback.clone(),
        };
        items.push(CommitSummary {
            id,
            short_id: fields[1].to_string(),
            summary: fields[2].to_string(),
            body: String::new(),
            author_name: fields[3].to_string(),
            author_email: fields[4].to_string(),
            timestamp: fields[5].trim().parse().unwrap_or(0),
            parents: fields[6]
                .split_whitespace()
                .filter_map(normalize_oid)
                .collect(),
            refs: Vec::new(),
            on_current_branch: true,
            on_tracking_branch: false,
            path: Some(path),
        });
    }
    items
}
