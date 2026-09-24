use super::*;

pub(super) fn summarize_oid(repo: &Repository, oid: Oid) -> AppResult<CommitSummary> {
    let commit = repo.find_commit(oid)?;
    let id = oid.to_string();
    let short_id = id.chars().take(7).collect();
    let author = commit.author();
    let author_name = author.name().unwrap_or("Unknown").to_string();
    let author_email = author.email().unwrap_or("").to_string();
    Ok(CommitSummary {
        id,
        short_id,
        summary: commit.summary().unwrap_or("").to_string(),
        body: commit.body().unwrap_or("").trim().to_string(),
        author_name,
        author_email,
        timestamp: commit.time().seconds(),
        parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
        path: None,
    })
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
    if let Ok(root) = workdir(repo) {
        // Committer-date order, unlike author-date order, lets git stream from
        // the commit-graph instead of sorting all of history first.
        let args = git_log_args(&revs, &["-c", "log.showSignature=false", "log", "--date-order"]);
        let warming = if skip == 0 { warm_reachable(repo) } else { Vec::new() };
        let page = log_page(root, &args, skip, limit);
        for handle in warming {
            let _ = handle.join();
        }
        if let Ok(stdout) = page {
            let mut items = parse_git_log(&stdout)?;
            decorate_commits(repo, &mut items);
            return Ok(items);
        }
    }
    let mut items = commits_from_revwalk(repo, limit, skip, &revs)?;
    decorate_commits(repo, &mut items);
    Ok(items)
}

pub(super) fn normalize_revs(revs: &[String]) -> Vec<String> {
    revs
        .iter()
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

pub(super) fn git_search_log_args(revs: &[String]) -> Vec<String> {
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
    args.push("--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P".to_string());
    args.extend(revs.iter().cloned());
    args
}

pub(super) fn search_commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: &str,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let needle = query.to_lowercase();
    let labels = collect_ref_labels(repo);
    let mut items = Vec::new();
    let mut skipped = 0usize;

    if let Ok(root) = workdir(repo) {
        let args = git_search_log_args(revs);
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
        let _ = child.kill();
        let _ = child.wait();
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

pub(super) fn commits_from_revwalk(
    repo: &Repository,
    limit: usize,
    skip: usize,
    revs: &[String],
) -> AppResult<Vec<CommitSummary>> {
    let mut revwalk = repo.revwalk()?;
    if revs.is_empty() {
        let _ = revwalk.push_glob("refs/heads/*");
        let _ = revwalk.push_glob("refs/remotes/*");
    } else {
        for rev in revs {
            let object = repo.revparse_single(rev)?;
            revwalk.push(object.peel_to_commit()?.id())?;
        }
    }
    // TIME | TOPOLOGICAL matches `git log --date-order` (committer time, parents
    // still below their children), the same order as the CLI path above.
    revwalk.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;

    let mut items = Vec::new();
    for oid in revwalk.skip(skip).take(limit) {
        items.push(summarize_oid(repo, oid?)?);
    }
    Ok(items)
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
        let Some(short_id) = fields.next() else { continue };
        let Some(summary) = fields.next() else { continue };
        let Some(author_name) = fields.next() else { continue };
        let Some(author_email) = fields.next() else { continue };
        let Some(timestamp) = fields.next() else { continue };
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
    let head = repo.head().ok();
    let head_oid = head.as_ref().and_then(|head| head.target());
    let upstream_oid = head.as_ref().and_then(|head| upstream_oid_of(repo, head));
    if commit_graph_available(repo) {
        mark_branch_flags_with_graph(repo, commits, head_oid, upstream_oid);
        return;
    }
    let on_head = head_oid.and_then(|oid| reachable_commits(repo, oid));
    let on_upstream = upstream_oid.and_then(|oid| reachable_commits(repo, oid));
    if (on_head.is_none() && head_oid.is_some())
        || (on_upstream.is_none() && upstream_oid.is_some())
    {
        mark_branch_flags_with_graph(repo, commits, head_oid, upstream_oid);
        return;
    }
    let head_id = head_oid.map(|oid| oid.to_string());
    let upstream_id = upstream_oid.map(|oid| oid.to_string());
    for commit in commits {
        let Ok(oid) = Oid::from_str(&commit.id) else {
            commit.on_current_branch = head_id.as_deref() == Some(commit.id.as_str());
            commit.on_tracking_branch = upstream_id.as_deref() == Some(commit.id.as_str());
            continue;
        };
        commit.on_current_branch = on_head.as_ref().is_some_and(|set| set.contains(&oid));
        commit.on_tracking_branch = on_upstream.as_ref().is_some_and(|set| set.contains(&oid));
    }
}

pub(super) fn mark_branch_flags_with_graph(
    repo: &Repository,
    commits: &mut [CommitSummary],
    head_oid: Option<Oid>,
    upstream_oid: Option<Oid>,
) {
    let head_id = head_oid.map(|oid| oid.to_string());
    let upstream_id = upstream_oid.map(|oid| oid.to_string());
    for commit in commits {
        let Ok(oid) = Oid::from_str(&commit.id) else {
            commit.on_current_branch = head_id.as_deref() == Some(commit.id.as_str());
            commit.on_tracking_branch = upstream_id.as_deref() == Some(commit.id.as_str());
            continue;
        };
        commit.on_current_branch = contains_commit(repo, head_oid, &head_id, oid, &commit.id);
        commit.on_tracking_branch =
            contains_commit(repo, upstream_oid, &upstream_id, oid, &commit.id);
    }
}

pub(super) fn commit_graph_available(repo: &Repository) -> bool {
    let git_dir = repo.path();
    if git_dir.join("objects/info/commit-graph").is_file() {
        return true;
    }
    git_dir
        .join("objects/info/commit-graphs")
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// Without a commit-graph, marking commits on the current branch walks all of
/// history. Starting those walks on helper threads lets them overlap the
/// `git log` process instead of following it.
fn warm_reachable(repo: &Repository) -> Vec<thread::JoinHandle<()>> {
    if commit_graph_available(repo) {
        return Vec::new();
    }
    let Ok(head) = repo.head() else { return Vec::new() };
    let mut tips: Vec<Oid> = [head.target(), upstream_oid_of(repo, &head)]
        .into_iter()
        .flatten()
        .collect();
    tips.dedup();
    let git_dir = repo.path().to_path_buf();
    tips.into_iter()
        .map(|tip| {
            let git_dir = git_dir.clone();
            thread::spawn(move || {
                if let Ok(repo) = Repository::open(&git_dir) {
                    let _ = reachable_commits(&repo, tip);
                }
            })
        })
        .collect()
}

pub(super) fn reachable_commits(repo: &Repository, tip: Oid) -> Option<Arc<HashSet<Oid>>> {
    enum Cached {
        Set(Arc<HashSet<Oid>>),
        TooBig,
    }
    const MAX_REACHABLE: usize = 2_000_000;
    static CACHE: OnceLock<Mutex<Vec<(Oid, Cached)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((_, cached)) = guard.iter().find(|(oid, _)| *oid == tip) {
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
        guard.retain(|(oid, _)| *oid != tip);
        guard.push((tip, cached));
        if guard.len() > 4 {
            let extra = guard.len() - 4;
            guard.drain(0..extra);
        }
    }
    result
}

pub(super) fn walk_reachable(repo: &Repository, tip: Oid, limit: usize) -> Option<HashSet<Oid>> {
    let mut walk = repo.revwalk().ok()?;
    walk.push(tip).ok()?;
    let mut set = HashSet::new();
    for oid in walk.flatten() {
        set.insert(oid);
        if set.len() > limit {
            return None;
        }
    }
    if set.is_empty() {
        return None;
    }
    Some(set)
}

pub(super) fn upstream_oid_of(repo: &Repository, head: &git2::Reference) -> Option<Oid> {
    if !head.is_branch() {
        return None;
    }
    let branch = repo
        .find_branch(head.shorthand()?, BranchType::Local)
        .ok()?;
    branch.upstream().ok()?.get().target()
}

pub(super) fn contains_commit(
    repo: &Repository,
    tip: Option<Oid>,
    tip_id: &Option<String>,
    oid: Oid,
    id: &str,
) -> bool {
    if tip_id.as_deref() == Some(id) {
        return true;
    }
    let Some(tip) = tip else {
        return false;
    };
    repo.graph_descendant_of(tip, oid).unwrap_or(false)
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

    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            let entry = labels.entry(oid.to_string()).or_default();
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
    Ok(parse_follow_log(&stdout, &rel).into_iter().skip(skip).collect())
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
        let Some(id) = normalize_oid(fields[0]) else { continue };
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
            parents: fields[6].split_whitespace().filter_map(normalize_oid).collect(),
            refs: Vec::new(),
            on_current_branch: true,
            on_tracking_branch: false,
            path: Some(path),
        });
    }
    items
}
