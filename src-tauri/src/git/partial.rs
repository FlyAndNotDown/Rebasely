use super::*;

/// One changed line picked in the diff: an added line by its new number, a
/// removed line by its old number.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRef {
    pub old: Option<u32>,
    pub new: Option<u32>,
}

fn quote_patch_path(path: &str) -> Vec<u8> {
    let mut out = vec![b'"'];
    for byte in path.bytes() {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\t' => out.extend_from_slice(b"\\t"),
            _ => out.push(byte),
        }
    }
    out.push(b'"');
    out
}

/// Builds a patch holding only the selected lines of `diff`.
///
/// Applied forwards, an unselected removal stays as context and an unselected
/// addition is left out. A `reverse` patch is meant for `git apply --reverse`,
/// so the roles swap: unselected additions stay as context and unselected
/// removals are left out. Either way the preimage matches the file exactly.
pub(super) fn selected_patch(
    diff: &git2::Diff<'_>,
    rel: &str,
    lines: &[LineRef],
    reverse: bool,
) -> AppResult<Vec<u8>> {
    let olds: HashSet<u32> = lines.iter().filter_map(|line| line.old).collect();
    let news: HashSet<u32> = lines.iter().filter_map(|line| line.new).collect();
    let index = diff
        .deltas()
        .position(|delta| {
            delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .is_some_and(|path| path.to_string_lossy().replace('\\', "/") == rel)
        })
        .ok_or_else(|| AppError::msg("This file has no changes to apply"))?;
    let patch = git2::Patch::from_diff(diff, index)?
        .ok_or_else(|| AppError::msg("Binary files cannot be applied line by line"))?;
    if patch.delta().flags().contains(git2::DiffFlags::BINARY) {
        return Err(AppError::msg("Binary files cannot be applied line by line"));
    }

    let a = quote_patch_path(&format!("a/{rel}"));
    let b = quote_patch_path(&format!("b/{rel}"));
    let mut out = Vec::new();
    out.extend_from_slice(b"diff --git ");
    out.extend_from_slice(&a);
    out.push(b' ');
    out.extend_from_slice(&b);
    out.extend_from_slice(b"\n--- ");
    out.extend_from_slice(&a);
    out.extend_from_slice(b"\n+++ ");
    out.extend_from_slice(&b);
    out.push(b'\n');

    let mut offset: i64 = 0;
    let mut emitted = 0;
    for hunk_index in 0..patch.num_hunks() {
        let (hunk, count) = patch.hunk(hunk_index)?;
        let mut body = Vec::new();
        let (mut old_count, mut new_count, mut changes) = (0i64, 0i64, 0);
        for line_index in 0..count {
            let line = patch.line_in_hunk(hunk_index, line_index)?;
            let origin = line.origin();
            let selected = match origin {
                '+' => line
                    .new_lineno()
                    .is_some_and(|number| news.contains(&number)),
                '-' => line
                    .old_lineno()
                    .is_some_and(|number| olds.contains(&number)),
                _ => false,
            };
            let mark = match (origin, selected, reverse) {
                (' ', _, _) => b' ',
                ('+', true, _) => b'+',
                ('-', true, _) => b'-',
                ('-', false, false) | ('+', false, true) => b' ',
                // Unselected lines that are not in the preimage, and the
                // end-of-file markers, which are added back below.
                _ => continue,
            };
            if mark != b' ' {
                changes += 1;
            }
            if mark != b'+' {
                old_count += 1;
            }
            if mark != b'-' {
                new_count += 1;
            }
            body.push(mark);
            let content = line.content();
            body.extend_from_slice(content);
            if !content.ends_with(b"\n") {
                body.extend_from_slice(b"\n\\ No newline at end of file\n");
            }
        }
        if changes == 0 {
            continue;
        }
        let (old_start, new_start) = if reverse {
            let new_start = i64::from(hunk.new_start());
            let mut old_start = new_start - offset;
            if new_count == 0 {
                old_start += 1;
            }
            if old_count == 0 {
                old_start -= 1;
            }
            (old_start.max(0), new_start)
        } else {
            let old_start = i64::from(hunk.old_start());
            let mut new_start = old_start + offset;
            if old_count == 0 {
                new_start += 1;
            }
            if new_count == 0 {
                new_start -= 1;
            }
            (old_start, new_start.max(0))
        };
        out.extend_from_slice(
            format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes(),
        );
        out.extend_from_slice(&body);
        offset += new_count - old_count;
        emitted += 1;
    }
    if emitted == 0 {
        return Err(AppError::msg(
            "The selected lines are no longer changes in this file. Refresh and try again.",
        ));
    }
    Ok(out)
}

/// Stages, unstages, or discards only the selected lines of one file.
/// `staged` says which diff the lines came from: HEAD to index, or index to
/// working tree.
pub fn apply_lines(
    repo: &mut Repository,
    path: &str,
    staged: bool,
    action: &str,
    lines: &[LineRef],
) -> AppResult<WorkspaceSnapshot> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    if lines.is_empty() {
        return Err(AppError::msg("Select at least one changed line"));
    }
    let (reverse, cached) = match (action, staged) {
        ("stage", false) => (false, true),
        ("unstage", true) => (true, true),
        ("discard", false) => (true, false),
        _ => return Err(AppError::msg("That action does not apply to this diff")),
    };
    let root = workdir_owned(repo)?;
    // A new file needs an index entry before part of it can be staged.
    let intent_to_add = action == "stage"
        && repo
            .status_file(Path::new(&rel))
            .ok()
            .is_some_and(is_untracked);
    if intent_to_add {
        run_git_pathspecs(
            &root,
            &["add", "--intent-to-add"],
            std::slice::from_ref(&rel),
        )?;
    }
    let result = (|| {
        let patch = {
            let diff = change_diff(repo, &rel, staged, false)?;
            selected_patch(&diff, &rel, lines, reverse)?
        };
        let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
        if cached {
            args.push("--cached");
        }
        if reverse {
            args.push("--reverse");
        }
        args.push("-");
        run_git_input(&root, &args, &patch)
    })();
    if let Err(err) = result {
        if intent_to_add {
            let _ = run_git_pathspecs(&root, &["reset", "--quiet"], std::slice::from_ref(&rel));
        }
        return Err(err);
    }
    snapshot(repo)
}
