use super::*;

#[derive(Debug, Clone)]
pub(super) struct ParsedDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub hunks: Vec<ParsedHunk>,
}

#[derive(Debug, Clone)]
pub(super) struct ParsedHunk {
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<ParsedLine>,
}

#[derive(Debug, Clone)]
pub(super) struct ParsedLine {
    pub origin: u8,
    pub content: Vec<u8>,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

/// The diff shown for a changed file: HEAD to index when `staged`, otherwise
/// index to working tree. Line staging rebuilds patches from this same diff,
/// so the line numbers the UI sends always match. `ignore_whitespace` is for
/// display only; applying lines always passes false.
pub(super) fn change_diff(
    repo: &Repository,
    rel: &str,
    staged: bool,
    ignore_whitespace: bool,
) -> AppResult<ParsedDiff> {
    let stdout = git_diff_bytes(repo, &[], staged, ignore_whitespace, rel)?;
    Ok(parse_unified_diff(&stdout, rel))
}

pub fn workdir_diff(
    repo: &Repository,
    path: &str,
    staged: bool,
    ignore_whitespace: bool,
) -> AppResult<FileDiff> {
    let rel = to_git_path(path);
    let parsed = change_diff(repo, &rel, staged, ignore_whitespace)?;
    let file_diff = file_diff_from_parsed(&parsed, &rel);
    if !staged && !file_diff.binary && file_diff.lines.is_empty() {
        if let Some(fallback) = untracked_workdir_diff(repo, &rel)? {
            return Ok(fallback);
        }
    }
    Ok(file_diff)
}

pub(super) fn untracked_workdir_diff(repo: &Repository, path: &str) -> AppResult<Option<FileDiff>> {
    if !is_untracked(repo, path) {
        return Ok(None);
    }
    if looks_binary_path(path) {
        return Ok(Some(FileDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        }));
    }

    let abs = ensure_inside_workdir(repo, path)?;
    if !abs.is_file() {
        return Ok(None);
    }
    let (bytes, cut) = read_text_prefix(&abs)?;
    if bytes.contains(&0) {
        return Ok(Some(FileDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        }));
    }

    let text = String::from_utf8_lossy(&bytes);
    let body = text.strip_suffix('\n').unwrap_or(&text);
    let mut lines = Vec::new();
    let mut truncated = cut;
    if !text.is_empty() {
        let total = body.split('\n').count();
        lines.push(DiffLine {
            kind: "hunk".to_string(),
            content: format!("@@ -0,0 +1,{total} @@"),
            old_lineno: None,
            new_lineno: None,
        });
        for (index, line) in body.split('\n').enumerate() {
            if lines.len() > MAX_DIFF_LINES {
                truncated = true;
                break;
            }
            let content = line.strip_suffix('\r').unwrap_or(line).to_string();
            lines.push(DiffLine {
                kind: "add".to_string(),
                content,
                old_lineno: None,
                new_lineno: Some((index + 1) as u32),
            });
        }
    }
    Ok(Some(FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated,
        lines,
    }))
}

pub fn commit_details(repo: &Repository, oid: &str) -> AppResult<CommitDetails> {
    let info = commit_info(repo, oid)?;
    let files = commit_files_from_git(workdir(repo)?, &info.id)?;
    Ok(CommitDetails {
        commit: summary_from_info(&info),
        files,
    })
}

pub(super) fn commit_files_from_git(root: &Path, oid: &str) -> AppResult<Vec<CommitFile>> {
    let stdout = run_git_stdout(
        root,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "--no-renames",
            "--root",
            "--diff-merges=first-parent",
            "-z",
            oid,
        ],
    )?;
    parse_name_status_z(&stdout)
}

pub(super) fn parse_name_status_z(bytes: &[u8]) -> AppResult<Vec<CommitFile>> {
    let mut files = Vec::new();
    let mut parts = bytes.split(|b| *b == 0);
    while let Some(status) = parts.next() {
        if status.is_empty() {
            continue;
        }
        let status = std::str::from_utf8(status).unwrap_or("");
        let kind = match status.as_bytes().first() {
            Some(b'A') => "added",
            Some(b'D') => "deleted",
            Some(b'R') => "renamed",
            Some(b'C') => "copied",
            Some(b'T') => "typechange",
            Some(b'U') => "conflicted",
            _ => "modified",
        };
        let first = match parts.next() {
            Some(path) if !path.is_empty() => String::from_utf8_lossy(path).replace('\\', "/"),
            _ => continue,
        };
        let (path, old_path) = if matches!(kind, "renamed" | "copied") {
            match parts.next() {
                Some(path) if !path.is_empty() => (
                    String::from_utf8_lossy(path).replace('\\', "/"),
                    Some(first),
                ),
                _ => (first, None),
            }
        } else {
            (first, None)
        };
        files.push(CommitFile {
            binary: looks_binary_path(&path),
            path,
            old_path,
            kind: kind.to_string(),
        });
    }
    Ok(files)
}

pub fn compare_files(repo: &Repository, base: &str, head: &str) -> AppResult<Vec<CommitFile>> {
    let base = base.trim();
    let head = head.trim();
    if base.is_empty() || head.is_empty() {
        return Err(AppError::msg("Two revisions are required"));
    }
    let base = peel_commit(repo, base)?.id().to_string();
    let head = peel_commit(repo, head)?.id().to_string();
    compare_files_from_git(workdir(repo)?, &base, &head)
}

pub(super) fn compare_files_from_git(
    root: &Path,
    base: &str,
    head: &str,
) -> AppResult<Vec<CommitFile>> {
    let stdout = run_git_stdout(
        root,
        &["diff", "--name-status", "-z", "--find-renames", base, head],
    )?;
    parse_name_status_z(&stdout)
}

pub fn compare_file_diff(
    repo: &Repository,
    base: &str,
    head: &str,
    path: &str,
    ignore_whitespace: bool,
) -> AppResult<FileDiff> {
    let base = peel_commit(repo, base.trim())?.id().to_string();
    let head = peel_commit(repo, head.trim())?.id().to_string();
    diff_between(repo, &base, &head, path, ignore_whitespace)
}

pub fn commit_file_diff(
    repo: &Repository,
    oid: &str,
    path: &str,
    ignore_whitespace: bool,
) -> AppResult<FileDiff> {
    let info = commit_info(repo, oid.trim())?;
    let parent = info
        .parents
        .first()
        .map(String::as_str)
        .unwrap_or(EMPTY_TREE);
    diff_between(repo, parent, &info.id, path, ignore_whitespace)
}

pub(super) fn diff_between(
    repo: &Repository,
    base: &str,
    head: &str,
    path: &str,
    ignore_whitespace: bool,
) -> AppResult<FileDiff> {
    let rel = to_git_path(path);
    let stdout = git_diff_bytes(repo, &[base, head], false, ignore_whitespace, &rel)?;
    Ok(file_diff_from_parsed(
        &parse_unified_diff(&stdout, &rel),
        &rel,
    ))
}

fn git_diff_bytes(
    repo: &Repository,
    revisions: &[&str],
    staged: bool,
    ignore_whitespace: bool,
    path: &str,
) -> AppResult<Vec<u8>> {
    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.noprefix=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U3",
    ];
    if ignore_whitespace {
        args.push("-w");
    }
    if staged {
        args.push("--cached");
    }
    args.extend_from_slice(revisions);
    args.push("--");
    args.push(path);
    run_git_stdout(repo.workdir(), &args)
}

pub(super) fn file_diff_from_parsed(parsed: &ParsedDiff, fallback: &str) -> FileDiff {
    let path = if parsed.path.is_empty() {
        fallback.to_string()
    } else {
        parsed.path.clone()
    };
    let old_path = parsed.old_path.clone();
    if parsed.binary || looks_binary_path(&path) {
        return FileDiff {
            path,
            old_path,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        };
    }
    let mut lines = Vec::new();
    let mut truncated = false;
    for hunk in &parsed.hunks {
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            break;
        }
        lines.push(DiffLine {
            kind: "hunk".to_string(),
            content: hunk.header.clone(),
            old_lineno: None,
            new_lineno: None,
        });
        for line in &hunk.lines {
            if lines.len() >= MAX_DIFF_LINES {
                truncated = true;
                break;
            }
            let mut content = String::from_utf8_lossy(&line.content).into_owned();
            if content.ends_with('\n') {
                content.pop();
            }
            let kind = match line.origin {
                b'+' => "add",
                b'-' => "delete",
                _ => "context",
            };
            lines.push(DiffLine {
                kind: kind.to_string(),
                content,
                old_lineno: line.old_lineno,
                new_lineno: line.new_lineno,
            });
        }
        if truncated {
            break;
        }
    }
    FileDiff {
        path,
        old_path,
        binary: false,
        truncated,
        lines,
    }
}

pub(super) fn parse_unified_diff(bytes: &[u8], fallback: &str) -> ParsedDiff {
    let text = String::from_utf8_lossy(bytes);
    let mut raw: Vec<&str> = text.split('\n').collect();
    if raw.last().is_some_and(|line| line.is_empty()) {
        raw.pop();
    }
    let crlf = raw.first().is_some_and(|line| line.ends_with('\r'));
    let lines: Vec<String> = raw
        .into_iter()
        .map(|line| {
            if crlf {
                line.strip_suffix('\r').unwrap_or(line).to_string()
            } else {
                line.to_string()
            }
        })
        .collect();

    let mut parsed = ParsedDiff {
        path: fallback.replace('\\', "/"),
        old_path: None,
        binary: false,
        hunks: Vec::new(),
    };
    let mut hunk: Option<ParsedHunk> = None;
    let mut old_no = 0_u32;
    let mut new_no = 0_u32;
    let mut saw_file = false;

    for line in &lines {
        if line.starts_with("diff --git ") {
            if let Some(done) = hunk.take() {
                parsed.hunks.push(done);
            }
            if saw_file && parsed.path == fallback {
                break;
            }
            saw_file = true;
            parsed.hunks.clear();
            parsed.binary = false;
            parsed.old_path = None;
            parsed.path = fallback.replace('\\', "/");
            continue;
        }
        if let Some(name) = line.strip_prefix("rename from ") {
            let name = unquote_git_path(name.trim());
            if name != parsed.path {
                parsed.old_path = Some(name);
            }
            continue;
        }
        if let Some(name) = line.strip_prefix("rename to ") {
            parsed.path = unquote_git_path(name.trim());
            continue;
        }
        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            parsed.binary = true;
            parsed.hunks.clear();
            hunk = None;
            continue;
        }
        if line.starts_with("@@") {
            if let Some(done) = hunk.take() {
                parsed.hunks.push(done);
            }
            let Some((old_start, new_start)) = parse_hunk_header(line) else {
                continue;
            };
            old_no = old_start;
            new_no = new_start;
            hunk = Some(ParsedHunk {
                header: line.clone(),
                old_start,
                new_start,
                lines: Vec::new(),
            });
            continue;
        }
        if line.starts_with('\\') {
            if let Some(current) = hunk.as_mut() {
                if let Some(last) = current.lines.last_mut() {
                    if last.content.ends_with(b"\n") {
                        last.content.pop();
                    }
                }
            }
            continue;
        }
        let Some(current) = hunk.as_mut() else {
            continue;
        };
        let Some(origin) = line.as_bytes().first().copied() else {
            continue;
        };
        if !matches!(origin, b'+' | b'-' | b' ') {
            continue;
        }
        let mut content = line.as_bytes()[1..].to_vec();
        content.push(b'\n');
        if content.contains(&0) {
            parsed.binary = true;
            parsed.hunks.clear();
            hunk = None;
            continue;
        }
        let (old_lineno, new_lineno) = match origin {
            b' ' => {
                let pair = (Some(old_no), Some(new_no));
                old_no = old_no.saturating_add(1);
                new_no = new_no.saturating_add(1);
                pair
            }
            b'-' => {
                let pair = (Some(old_no), None);
                old_no = old_no.saturating_add(1);
                pair
            }
            _ => {
                let pair = (None, Some(new_no));
                new_no = new_no.saturating_add(1);
                pair
            }
        };
        current.lines.push(ParsedLine {
            origin,
            content,
            old_lineno,
            new_lineno,
        });
    }
    if let Some(done) = hunk.take() {
        if !parsed.binary {
            parsed.hunks.push(done);
        }
    }
    if parsed.binary {
        parsed.hunks.clear();
    }
    parsed
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(' ')?;
    let rest = rest.strip_prefix('+')?;
    let new = rest.split_once(' ').map(|(value, _)| value).unwrap_or(rest);
    let old_start = old.split(',').next()?.parse().ok()?;
    let new_start = new.split(',').next()?.parse().ok()?;
    Some((old_start, new_start))
}

fn unquote_git_path(value: &str) -> String {
    let value = value.trim();
    if !value.starts_with('"') {
        return value.replace('\\', "/");
    }
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 1;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            break;
        }
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            index += 1;
            match bytes[index] {
                b'\\' => out.push(b'\\'),
                b'"' => out.push(b'"'),
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'r' => out.push(b'\r'),
                digit @ b'0'..=b'7' => {
                    let mut value = u32::from(digit - b'0');
                    let mut taken = 1;
                    while taken < 3 && index + 1 < bytes.len() && bytes[index + 1].is_ascii_digit()
                    {
                        let next = bytes[index + 1];
                        if !matches!(next, b'0'..=b'7') {
                            break;
                        }
                        index += 1;
                        taken += 1;
                        value = (value << 3) + u32::from(next - b'0');
                    }
                    out.push(value as u8);
                }
                other => out.push(other),
            }
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::parse_unified_diff;

    #[test]
    fn unified_diff_keeps_line_numbers_and_a_missing_newline() {
        let raw = "\
diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 keep
-old
+new
 same
\\ No newline at end of file
";
        let parsed = parse_unified_diff(raw.as_bytes(), "file.txt");
        assert!(!parsed.binary);
        assert_eq!(parsed.hunks.len(), 1);
        let hunk = &parsed.hunks[0];
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.lines.len(), 4);
        assert_eq!(hunk.lines[0].origin, b' ');
        assert_eq!(hunk.lines[0].old_lineno, Some(1));
        assert_eq!(hunk.lines[0].new_lineno, Some(1));
        assert_eq!(hunk.lines[1].origin, b'-');
        assert_eq!(hunk.lines[1].old_lineno, Some(2));
        assert!(hunk.lines[1].new_lineno.is_none());
        assert_eq!(hunk.lines[2].origin, b'+');
        assert_eq!(hunk.lines[2].new_lineno, Some(2));
        assert!(!hunk.lines[3].content.ends_with(b"\n"));
        assert_eq!(hunk.lines[3].old_lineno, Some(3));
        assert_eq!(hunk.lines[3].new_lineno, Some(3));
    }

    #[test]
    fn unified_diff_marks_binary_files() {
        let raw = "\
diff --git a/icon.png b/icon.png
index 1111111..2222222 100644
Binary files a/icon.png and b/icon.png differ
";
        let parsed = parse_unified_diff(raw.as_bytes(), "icon.png");
        assert!(parsed.binary);
        assert!(parsed.hunks.is_empty());
    }
}
