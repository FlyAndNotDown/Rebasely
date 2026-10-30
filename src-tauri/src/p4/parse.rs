//! Parsers for `p4 -ztag`, client specs, config files, and unified diffs.
//!
//! These stay free of process calls so the workspace commands and the tests
//! share one reading of Perforce's text formats.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use crate::git::{strip_verbatim_prefix, DiffLine, FileDiff};

const MAX_DIFF_LINES: usize = 4000;

pub type ZtagRecord = BTreeMap<String, String>;

pub fn parse_ztag(text: &str) -> Vec<ZtagRecord> {
    let mut records = Vec::new();
    let mut current = ZtagRecord::new();
    let mut last_key: Option<String> = None;
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        let mut rest = line;
        let mut tagged = false;
        while let Some(next) = rest.strip_prefix("... ") {
            tagged = true;
            rest = next;
        }
        if tagged {
            let (key, value) = rest
                .split_once(' ')
                .map(|(key, value)| (key, value.to_string()))
                .unwrap_or((rest, String::new()));
            if key.is_empty() {
                continue;
            }
            if current.contains_key(key) {
                records.push(std::mem::take(&mut current));
            }
            current.insert(key.to_string(), value);
            last_key = Some(key.to_string());
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if let Some(key) = &last_key {
            if let Some(existing) = current.get_mut(key) {
                if !existing.is_empty() {
                    existing.push('\n');
                }
                existing.push_str(line.trim());
            }
        }
    }
    if !current.is_empty() {
        records.push(current);
    }
    records
}

/// Groups `depotFile0` / `action0` style keys into one map per index.
pub fn indexed_groups(record: &ZtagRecord) -> Vec<ZtagRecord> {
    let mut max_index = None;
    for key in record.keys() {
        if let Some((_, index)) = split_index(key) {
            if index > 10_000 {
                continue;
            }
            max_index = Some(max_index.map_or(index, |current: usize| current.max(index)));
        }
    }
    let Some(max_index) = max_index else {
        return Vec::new();
    };
    let mut groups = vec![ZtagRecord::new(); max_index + 1];
    for (key, value) in record {
        if let Some((stem, index)) = split_index(key) {
            if index > 10_000 {
                continue;
            }
            groups[index].insert(stem.to_string(), value.clone());
        }
    }
    groups
}

fn split_index(key: &str) -> Option<(&str, usize)> {
    let stem = key.trim_end_matches(|ch: char| ch.is_ascii_digit());
    if stem.len() == key.len() || stem.is_empty() {
        return None;
    }
    let index: usize = key[stem.len()..].parse().ok()?;
    Some((stem, index))
}

pub fn parse_p4config(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        map.insert(key.to_ascii_uppercase(), value.trim().to_string());
    }
    map
}

/// `p4 set` prints `P4PORT=ssl:perforce.example.com:1666 (set)`.
pub fn parse_p4_set(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r').trim();
        let Some((key, rest)) = line.split_once('=') else {
            continue;
        };
        let value = rest.split(" (").next().unwrap_or(rest).trim();
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        map.insert(key.to_ascii_uppercase(), value.to_string());
    }
    map
}

pub fn read_description(spec: &str) -> String {
    let mut lines = Vec::new();
    let mut reading = false;
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        if reading {
            if is_indented(line) {
                lines.push(line.trim_start_matches(['\t', ' ']));
                continue;
            }
            if line.is_empty() {
                continue;
            }
            break;
        }
        if is_field(line, "Description") {
            reading = true;
        }
    }
    let text = lines.join("\n").trim().to_string();
    if text == "<enter description here>" {
        String::new()
    } else {
        text
    }
}

pub fn set_description(spec: &str, description: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    let mut wrote = false;
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        if skipping {
            if is_indented(line) || line.is_empty() {
                continue;
            }
            skipping = false;
        }
        if is_field(line, "Description") {
            push_description(&mut out, description);
            wrote = true;
            skipping = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !wrote {
        if !out.ends_with('\n') && !out.is_empty() {
            out.push('\n');
        }
        push_description(&mut out, description);
    }
    out
}

fn push_description(out: &mut String, description: &str) {
    out.push_str("Description:\n");
    let text = description.trim();
    if text.is_empty() {
        out.push_str("\t<enter description here>\n");
        return;
    }
    for line in text.split('\n') {
        out.push('\t');
        out.push_str(line.trim_end());
        out.push('\n');
    }
}

pub fn spec_field(spec: &str, field: &str) -> String {
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        if !is_field(line, field) {
            continue;
        }
        let Some((_, value)) = line.split_once(':') else {
            continue;
        };
        return value.trim().to_string();
    }
    String::new()
}

pub fn remove_spec_field(spec: &str, field: &str) -> String {
    let mut out = String::new();
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        if is_field(line, field) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

pub fn set_spec_field(spec: &str, field: &str, value: &str) -> String {
    let mut out = String::new();
    let mut wrote = false;
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        if is_field(line, field) {
            out.push_str(field);
            out.push_str(":\t");
            out.push_str(value);
            out.push('\n');
            wrote = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !wrote {
        out.push_str(field);
        out.push_str(":\t");
        out.push_str(value);
        out.push('\n');
    }
    out
}

pub fn depot_view(path: &str) -> String {
    let path = path.trim().trim_end_matches('/');
    if path.ends_with("/...") {
        path.to_string()
    } else {
        format!("{path}/...")
    }
}

pub fn known_p4_value(value: &str) -> bool {
    let value = value.trim();
    // `p4 info` reports sentinels such as `*unknown*` and `*error*` when a field
    // is not a real name. Those strings contain wildcards, so passing them as
    // P4USER or P4CLIENT makes the next command fail.
    !value.is_empty() && !value.eq_ignore_ascii_case("none") && !value.contains('*')
}

pub fn valid_client_name(name: &str) -> bool {
    let name = name.trim();
    (1..=128).contains(&name.len())
        && !name.starts_with('.')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

pub fn valid_depot_path(path: &str) -> bool {
    let path = path.trim();
    path.starts_with("//") && path.len() > 2 && !path.contains([' ', '\\', '?', '*', '#', '@'])
}

/// Paths from `p4 diff -sr` can be local paths (`C:\work\client\file.txt`),
/// depot revisions (`//depot/main/file.txt#3`), or a pair of depot revisions
/// separated by `- vs`. Error lines are skipped.
pub fn parse_unchanged_diff_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_matches('"');
        if line.is_empty() || unchanged_diff_error(line) {
            continue;
        }
        if let Some(start) = line.find("//") {
            let rest = &line[start..];
            let end = rest.find(['#', ' ', '\t']).unwrap_or(rest.len());
            let path = &rest[..end];
            if valid_depot_path(path) {
                let tail = revision_tail(&rest[end..]);
                if tail.is_empty() || tail.starts_with("- vs") || tail.starts_with("vs ") {
                    paths.push(path.to_string());
                }
            }
            continue;
        }
        if local_diff_path(line) {
            paths.push(line.to_string());
        }
    }
    paths
}

fn local_diff_path(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return !line.contains(['*', '?']);
    }
    line.starts_with('/') && !line.starts_with("//")
}

fn unchanged_diff_error(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("error")
        || lower.contains("not opened")
        || lower.contains("no such file")
        || lower.contains("protected")
        || lower.contains("must refer")
}

fn revision_tail(rest: &str) -> &str {
    let rest = rest.trim();
    let Some(stripped) = rest.strip_prefix('#') else {
        return rest;
    };
    let digits = stripped
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .count();
    stripped[digits..].trim()
}

pub fn normalize_charset(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "none" => String::new(),
        "utf8" | "utf8-bom" | "utf16" | "utf16le" | "utf16be" | "utf32le" | "utf32be" => {
            value.trim().to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

pub fn path_is_within(root: &Path, path: &Path) -> bool {
    let root = folded_components(root);
    let path = folded_components(path);
    !root.is_empty() && path.len() >= root.len() && path[..root.len()] == root[..]
}

pub fn path_depth(root: &Path, path: &Path) -> Option<usize> {
    if !path_is_within(root, path) {
        return None;
    }
    Some(folded_components(path).len() - folded_components(root).len())
}

fn folded_components(path: &Path) -> Vec<String> {
    let text = strip_verbatim_prefix(&path.to_string_lossy());
    PathBuf::from(text)
        .components()
        .filter_map(|component| match component {
            Component::CurDir | Component::ParentDir => None,
            Component::RootDir => Some(String::new()),
            Component::Prefix(prefix) => Some(fold(&prefix.as_os_str().to_string_lossy())),
            Component::Normal(part) => Some(fold(&part.to_string_lossy())),
        })
        .collect()
}

fn fold(text: &str) -> String {
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text.to_string()
    }
}

#[cfg(test)]
pub fn parse_describe_diffs(text: &str) -> Vec<FileDiff> {
    split_sections(text)
        .into_iter()
        .filter_map(|section| {
            let path = section.path?;
            Some(diff_from_section(&path, section.binary, &section.body))
        })
        .collect()
}

pub fn parse_single_diff(text: &str, path: &str) -> FileDiff {
    let sections = split_sections(text);
    if let Some(section) = sections.iter().find(|section| section.path.is_some()) {
        let file = section.path.clone().unwrap_or_else(|| path.to_string());
        return diff_from_section(&file, section.binary, &section.body);
    }
    diff_from_section(path, false, text)
}

struct DiffSection {
    path: Option<String>,
    binary: bool,
    body: String,
}

fn split_sections(text: &str) -> Vec<DiffSection> {
    let mut sections = Vec::new();
    let mut current = DiffSection {
        path: None,
        binary: false,
        body: String::new(),
    };
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        if let Some((path, binary)) = header_path(line) {
            if current.path.is_some() || !current.body.trim().is_empty() {
                sections.push(current);
            }
            current = DiffSection {
                path: Some(path),
                binary,
                body: String::new(),
            };
            continue;
        }
        current.body.push_str(line);
        current.body.push('\n');
    }
    if current.path.is_some() || !current.body.trim().is_empty() {
        sections.push(current);
    }
    sections
}

fn header_path(line: &str) -> Option<(String, bool)> {
    let rest = line.strip_prefix("==== ")?.trim();
    let rest = rest.trim_end_matches("====").trim();
    let binary = header_type_is_binary(rest);
    let path = rest
        .split(" - ")
        .next()
        .unwrap_or(rest)
        .split('#')
        .next()
        .unwrap_or(rest)
        .trim();
    if path.is_empty() || !path.starts_with("//") {
        return None;
    }
    Some((path.to_string(), binary))
}

fn diff_from_section(path: &str, binary: bool, body: &str) -> FileDiff {
    if binary || body_is_binary(body) {
        return FileDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            truncated: false,
            lines: Vec::new(),
        };
    }
    let mut lines = Vec::new();
    let mut truncated = false;
    let mut old_no = 0_u32;
    let mut new_no = 0_u32;
    let mut in_hunk = false;
    for raw in body.split('\n') {
        let line = raw.trim_end_matches('\r');
        if let Some((old_start, new_start)) = parse_hunk_header(line) {
            if lines.len() >= MAX_DIFF_LINES {
                truncated = true;
                break;
            }
            lines.push(DiffLine {
                kind: "hunk".to_string(),
                content: line.to_string(),
                old_lineno: None,
                new_lineno: None,
            });
            old_no = old_start;
            new_no = new_start;
            in_hunk = true;
            continue;
        }
        if !in_hunk || line.starts_with('\\') {
            continue;
        }
        let Some(origin) = line.chars().next() else {
            continue;
        };
        if origin != '+' && origin != '-' && origin != ' ' {
            continue;
        }
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            break;
        }
        let content = line[origin.len_utf8()..].to_string();
        let (kind, old_lineno, new_lineno) = match origin {
            '+' => {
                let lineno = lineno(new_no);
                new_no = new_no.saturating_add(1);
                ("add", None, lineno)
            }
            '-' => {
                let lineno = lineno(old_no);
                old_no = old_no.saturating_add(1);
                ("delete", lineno, None)
            }
            _ => {
                let old_lineno = lineno(old_no);
                let new_lineno = lineno(new_no);
                old_no = old_no.saturating_add(1);
                new_no = new_no.saturating_add(1);
                ("context", old_lineno, new_lineno)
            }
        };
        lines.push(DiffLine {
            kind: kind.to_string(),
            content,
            old_lineno,
            new_lineno,
        });
    }
    FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated,
        lines,
    }
}

pub fn file_type_is_binary(file_type: &str) -> bool {
    let base = file_type
        .split('+')
        .next()
        .unwrap_or(file_type)
        .trim()
        .trim_matches(|ch: char| ch == '(' || ch == ')');
    matches!(
        base.to_ascii_lowercase().as_str(),
        "binary" | "ubinary" | "apple" | "resource" | "uresource" | "uxbinary"
    )
}

fn header_type_is_binary(header: &str) -> bool {
    let Some(open) = header.rfind('(') else {
        return false;
    };
    let Some(close) = header[open..].find(')') else {
        return false;
    };
    file_type_is_binary(&header[open + 1..open + close])
}

/// `p4 sync -N` prints `files added/updated/deleted=1/2/3`.
pub fn sync_estimate_files(text: &str) -> Option<u64> {
    let rest = text.split_once("files added/updated/deleted=")?.1;
    let numbers = rest.split([',', ' ', '\r', '\n']).next()?.trim();
    if numbers.is_empty() {
        return None;
    }
    let mut total = 0_u64;
    for part in numbers.split('/') {
        total = total.checked_add(part.parse::<u64>().ok()?)?;
    }
    Some(total)
}

pub fn sync_reports_a_file(line: &str) -> bool {
    const MARKERS: [&str; 5] = [
        " - updating ",
        " - added ",
        " - deleted ",
        " - refreshing ",
        " - moved ",
    ];
    MARKERS.iter().any(|marker| line.contains(marker))
}

fn body_is_binary(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    !lower.contains("@@")
        && (lower.contains("binary") || lower.contains("file type") && lower.contains("differ"))
}

fn lineno(value: u32) -> Option<u32> {
    if value == 0 {
        None
    } else {
        Some(value)
    }
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ ")?;
    let (old, new) = rest.split_once(' ')?;
    let old_start = range_start(old.strip_prefix('-')?);
    let new_part = new.strip_prefix('+')?;
    let new_start = range_start(new_part.split(" @@").next().unwrap_or(new_part));
    Some((old_start, new_start))
}

fn range_start(text: &str) -> u32 {
    text.split(',').next().unwrap_or("0").parse().unwrap_or(0)
}

fn is_field(line: &str, field: &str) -> bool {
    let Some((name, _)) = line.split_once(':') else {
        return false;
    };
    name.trim().eq_ignore_ascii_case(field)
}

fn is_indented(line: &str) -> bool {
    line.starts_with('\t') || line.starts_with(' ')
}

pub fn classic_client_spec(client: &str, user: &str, root: &str, depot_path: &str) -> String {
    let view = depot_view(depot_path);
    format!(
        "Client:\t{client}\nOwner:\t{user}\nRoot:\t{root}\nDescription:\n\tCreated by Rebasely.\n\nOptions:\tnoallwrite noclobber nocompress unlocked nomodtime normdir noaltsync\nSubmitOptions:\tsubmitunchanged\nLineEnd:\tlocal\nView:\n\t{view} //{client}/...\n"
    )
}

pub fn blank_change_spec(client: &str, user: &str, description: &str) -> String {
    set_description(
        &format!("Change:\tnew\nClient:\t{client}\nUser:\t{user}\nStatus:\tnew\nDescription:\n\t<enter description here>\n"),
        description,
    )
}

pub fn created_change_id(text: &str) -> Option<String> {
    for word in text.split_whitespace() {
        if word.chars().all(|ch| ch.is_ascii_digit()) && !word.is_empty() {
            return Some(word.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ztag_splits_records_and_keeps_multiline_values() {
        let text = "\
... change 12
... user alice
... desc Fix it
and the rest

... change 11
... user bob
... desc Other
";
        let records = parse_ztag(text);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].get("change").map(String::as_str), Some("12"));
        assert_eq!(
            records[0].get("desc").map(String::as_str),
            Some("Fix it\nand the rest")
        );
        assert_eq!(records[1].get("user").map(String::as_str), Some("bob"));
    }

    #[test]
    fn ztag_reads_a_repeated_tag_prefix_as_one_field() {
        let text = "\
... clientFile E:\\depot\\p4ignore.txt
... headRev 70
... haveRev 70
... ... otherOpen 1
";
        let records = parse_ztag(text);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].get("otherOpen").map(String::as_str), Some("1"));
        assert_eq!(records[0].get("haveRev").map(String::as_str), Some("70"));
    }

    #[test]
    fn indexed_groups_follow_the_numeric_suffix() {
        let mut record = ZtagRecord::new();
        record.insert("depotFile0".into(), "//depot/a".into());
        record.insert("action0".into(), "edit".into());
        record.insert("depotFile1".into(), "//depot/b".into());
        record.insert("action1".into(), "add".into());
        let groups = indexed_groups(&record);
        assert_eq!(groups.len(), 2);
        assert_eq!(
            groups[1].get("depotFile").map(String::as_str),
            Some("//depot/b")
        );
        assert_eq!(groups[1].get("action").map(String::as_str), Some("add"));
    }

    #[test]
    fn config_and_p4_set_ignore_comments_and_source_tags() {
        let config =
            parse_p4config("# note\nP4PORT=ssl:perforce.example.com:1666\nP4CLIENT=alice_main\n");
        assert_eq!(
            config.get("P4PORT").map(String::as_str),
            Some("ssl:perforce.example.com:1666")
        );
        let set = parse_p4_set("P4USER=alice (set) (config 'noconfig')\n");
        assert_eq!(set.get("P4USER").map(String::as_str), Some("alice"));
    }

    #[test]
    fn description_round_trip_keeps_the_files_section() {
        let spec = "\
Change:\tnew
Description:
\t<enter description here>

Files:
\t//depot/foo\t# edit
";
        let next = set_description(spec, "Fix the build\nMore");
        assert_eq!(read_description(&next), "Fix the build\nMore");
        assert!(next.contains("Files:"));
        assert!(next.contains("//depot/foo"));
        assert!(read_description(spec).is_empty());
    }

    #[test]
    fn root_field_and_depot_view_are_readable() {
        let spec = classic_client_spec("alice_main", "alice", r"D:\work", "//depot/game");
        let moved = set_spec_field(&spec, "Root", r"E:\work");
        assert_eq!(spec_field(&moved, "Root"), r"E:\work");
        assert!(moved.contains("Root:\tE:\\work"));
        let cleared = remove_spec_field(&moved, "Root");
        assert!(spec_field(&cleared, "Root").is_empty());
        assert!(!cleared.lines().any(|line| line.starts_with("Root:")));
        assert_eq!(depot_view("//depot/main"), "//depot/main/...");
        assert_eq!(depot_view("//depot/main/..."), "//depot/main/...");
    }

    #[test]
    fn names_paths_and_charsets_are_constrained() {
        assert!(valid_client_name("alice_main"));
        assert!(!valid_client_name("alice main"));
        assert!(!valid_client_name(".hidden"));
        assert!(valid_depot_path("//depot/main"));
        assert!(!valid_depot_path("depot/main"));
        assert_eq!(normalize_charset(" UTF8 "), "utf8");
        assert_eq!(normalize_charset("nope"), "");
        assert!(known_p4_value("alice"));
        assert!(!known_p4_value("*unknown*"));
        assert!(!known_p4_value("*error*"));
        assert!(!known_p4_value("none"));
    }

    #[test]
    fn unchanged_diff_keeps_identical_files_and_skips_errors() {
        let paths = parse_unchanged_diff_paths(
            "\
//depot/main/mobile.ini#4 - vs //depot/main/mobile.ini#4
//depot/main/desktop.ini#2
C:\\work\\client\\Config\\Linux\\server.ini
//depot/main/Missing.ini - file(s) not opened on this client.
error: something failed for //depot/main/Other.ini#1
",
        );
        assert_eq!(
            paths,
            vec![
                "//depot/main/mobile.ini".to_string(),
                "//depot/main/desktop.ini".to_string(),
                r"C:\work\client\Config\Linux\server.ini".to_string(),
            ]
        );
    }

    #[test]
    fn a_path_is_inside_its_root_and_not_a_sibling() {
        let root = Path::new(r"C:\Repo");
        assert!(path_is_within(root, Path::new(r"C:\Repo\src")));
        assert!(path_is_within(root, Path::new(r"c:\repo")));
        assert!(!path_is_within(root, Path::new(r"C:\Repo2")));
        assert_eq!(path_depth(root, Path::new(r"C:\Repo\src\a")), Some(2));
        assert_eq!(path_depth(root, Path::new(r"D:\Repo")), None);
    }

    #[test]
    fn describe_diffs_split_files_and_drop_the_prefix() {
        let text = "\
==== //depot/main/foo.cpp#5 (text) ====

@@ -1,2 +1,3 @@
 context
-old
+new
==== //depot/main/blob.bin#2 (binary) ====
";
        let diffs = parse_describe_diffs(text);
        assert_eq!(diffs.len(), 2);
        assert_eq!(diffs[0].path, "//depot/main/foo.cpp");
        assert_eq!(diffs[0].lines[2].kind, "delete");
        assert_eq!(diffs[0].lines[2].content, "old");
        assert_eq!(diffs[0].lines[3].kind, "add");
        assert!(diffs[1].binary);
        let typed = parse_describe_diffs("==== //depot/main/mesh.uasset#4 (binary+l) ====\n");
        assert!(typed[0].binary);
        assert_eq!(
            sync_estimate_files("files added/updated/deleted=1/2/3, bytes added/updated=4/5"),
            Some(6)
        );
        assert!(sync_reports_a_file("//depot/a#2 - updating E:\\a"));
        assert!(!sync_reports_a_file(
            "//depot/a#2 - is opened and not being changed"
        ));
    }

    #[test]
    fn a_single_diff_without_a_banner_uses_the_fallback_path() {
        let text = "\
--- //depot/foo
+++ //depot/foo
@@ -1 +1 @@
-a
+b
";
        let diff = parse_single_diff(text, "//depot/foo");
        assert_eq!(diff.path, "//depot/foo");
        assert_eq!(diff.lines.len(), 3);
        assert_eq!(
            created_change_id("Change 1234 created."),
            Some("1234".into())
        );
    }

    #[test]
    fn hunk_content_that_looks_like_file_headers_keeps_its_line_numbers() {
        let diff = parse_single_diff(
            "--- //depot/main/file.txt\n+++ //depot/main/file.txt\n\
@@ -3,2 +3,2 @@\n--- old\n+++ new\n context\n",
            "//depot/main/file.txt",
        );
        assert_eq!(diff.lines.len(), 4);
        assert_eq!(diff.lines[1].kind, "delete");
        assert_eq!(diff.lines[1].content, "-- old");
        assert_eq!(diff.lines[1].old_lineno, Some(3));
        assert_eq!(diff.lines[2].kind, "add");
        assert_eq!(diff.lines[2].content, "++ new");
        assert_eq!(diff.lines[2].new_lineno, Some(3));
        assert_eq!(diff.lines[3].old_lineno, Some(4));
        assert_eq!(diff.lines[3].new_lineno, Some(4));
    }
}
