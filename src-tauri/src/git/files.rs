use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// Matches a git ignore rule and is not in the index. Tracked paths stay
    /// unmarked: a pattern does not ignore a file git already tracks.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub binary: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    pub start: u32,
    pub count: u32,
    pub commit_id: String,
    pub author: String,
    pub time: i64,
}

pub fn list_directory(repo: &Repository, path: &str) -> AppResult<Vec<DirEntry>> {
    let root = workdir(repo)?;
    let rel = safe_repo_path(path)?;
    let dir = root.join(&rel);
    let index = repo.index().ok();
    // An excluded directory stays excluded for everything inside it. `!` can
    // re-include a path only when no parent directory was itself excluded.
    let parent_ignored = excluded_directory(repo, &rel);
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|_| AppError::msg("Folder not found"))? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let kind = item.file_type()?;
        let dir = kind.is_dir();
        if !dir && !kind.is_file() {
            continue;
        }
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let ignored = path_ignored(repo, index.as_ref(), &path, dir, parent_ignored);
        entries.push(DirEntry {
            name,
            path,
            dir,
            ignored,
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

/// Ignore rules (`.gitignore`, `.git/info/exclude`, and the global excludes file)
/// hide this path. A trailing slash lets directory-only patterns such as `out/` match.
fn path_ignored(
    repo: &Repository,
    index: Option<&git2::Index>,
    rel: &str,
    dir: bool,
    parent_ignored: bool,
) -> bool {
    if index.is_some_and(|index| {
        let path = Path::new(rel);
        (0..4).any(|stage| index.get_path(path, stage).is_some())
    }) {
        return false;
    }
    if parent_ignored {
        return true;
    }
    let query = if dir { format!("{rel}/") } else { rel.to_string() };
    repo.status_should_ignore(Path::new(&query)).unwrap_or(false)
}

/// True when `rel` or a parent is an excluded directory.
///
/// libgit2 reports a file inside an excluded directory as ignored, but a child
/// directory there as not ignored when a rule like `!*/` re-includes directories.
/// Git still ignores those children: a negation cannot bring back a path whose
/// parent directory was excluded.
fn excluded_directory(repo: &Repository, rel: &str) -> bool {
    let mut current = rel;
    loop {
        if !current.is_empty()
            && repo
                .status_should_ignore(Path::new(&format!("{current}/")))
                .unwrap_or(false)
        {
            return true;
        }
        let Some(index) = current.rfind('/') else {
            return false;
        };
        current = &current[..index];
    }
}

pub fn read_file(repo: &Repository, path: &str) -> AppResult<FileText> {
    let full = work_file_path(repo, path)?;
    let too_large = fs::metadata(&full)
        .map_err(|_| AppError::msg("File not found"))?
        .len()
        > MAX_TEXT_BYTES;
    let bytes = if too_large {
        Vec::new()
    } else {
        fs::read(&full).map_err(|_| AppError::msg("File not found"))?
    };
    if too_large || bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Ok(FileText {
            binary: true,
            text: String::new(),
        });
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    Ok(FileText {
        binary: false,
        text,
    })
}

pub fn file_blame(repo: &Repository, path: &str) -> AppResult<Vec<BlameHunk>> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    let root = workdir(repo)?;
    let stdout = match run_git_stdout(root, &["blame", "-w", "--porcelain", "--", &rel]) {
        Ok(stdout) => stdout,
        // A file that is not in HEAD has no history yet; every line shows as not committed.
        Err(_) if !in_head(repo, &rel) => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    Ok(parse_blame_porcelain(&stdout))
}

fn in_head(repo: &Repository, rel: &str) -> bool {
    repo.head()
        .and_then(|head| head.peel_to_tree())
        .is_ok_and(|tree| tree.get_path(Path::new(rel)).is_ok())
}

pub(super) fn work_file_path(repo: &Repository, path: &str) -> AppResult<PathBuf> {
    let root = workdir(repo)?;
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    Ok(root.join(rel))
}

/// Reads at most `MAX_TEXT_BYTES`; the flag reports whether the file was longer.
pub(super) fn read_text_prefix(path: &Path) -> AppResult<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > MAX_TEXT_BYTES;
    bytes.truncate(MAX_TEXT_BYTES as usize);
    Ok((bytes, truncated))
}

pub(super) fn parse_blame_porcelain(bytes: &[u8]) -> Vec<BlameHunk> {
    let text = String::from_utf8_lossy(bytes);
    let mut known: std::collections::HashMap<String, (String, i64)> =
        std::collections::HashMap::new();
    let mut hunks: Vec<BlameHunk> = Vec::new();
    let mut oid = String::new();
    let mut author = String::new();
    let mut time = 0_i64;
    let mut described = false;
    let mut line_no = 0_u32;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(header) = blame_header(line) {
            oid = header;
            described = false;
            author.clear();
            time = 0;
            continue;
        }
        if let Some(name) = line.strip_prefix("author ") {
            if !name.starts_with("mail") && !name.starts_with("time") && !name.starts_with("tz") {
                author = name.to_string();
                described = true;
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("author-time ") {
            time = value.trim().parse().unwrap_or(0);
            continue;
        }
        if !line.starts_with('\t') {
            continue;
        }
        if oid.is_empty() || oid.chars().all(|ch| ch == '0') {
            line_no += 1;
            continue;
        }
        let (author, time) = if described {
            known.insert(oid.clone(), (author.clone(), time));
            (author.clone(), time)
        } else {
            known
                .get(&oid)
                .map(|(name, when)| (name.clone(), *when))
                .unwrap_or_else(|| (String::new(), 0))
        };
        if let Some(last) = hunks.last_mut() {
            if last.commit_id == oid && last.start + last.count == line_no {
                last.count += 1;
                line_no += 1;
                continue;
            }
        }
        hunks.push(BlameHunk {
            start: line_no,
            count: 1,
            commit_id: oid.clone(),
            author,
            time,
        });
        line_no += 1;
    }
    hunks
}

pub(super) fn blame_header(line: &str) -> Option<String> {
    let oid = line.get(..40)?;
    if !oid.chars().all(|ch| ch.is_ascii_hexdigit()) || !line[40..].starts_with(' ') {
        return None;
    }
    Some(oid.to_string())
}
