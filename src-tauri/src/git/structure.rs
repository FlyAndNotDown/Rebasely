use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub path: String,
    pub url: Option<String>,
    /// "clean", "uninitialized", "modified" (checked out at another commit than
    /// recorded), or "conflicted".
    pub state: String,
    pub commit: Option<String>,
}

/// Status output has no NUL mode. Match its paths against the NUL-delimited
/// configuration instead of treating newlines inside a path as record separators.
pub(super) fn parse_submodule_status(
    text: &str,
    paths: &[String],
) -> Vec<(String, String, String)> {
    let mut items = Vec::new();
    let mut rest = text;
    while let Some(flag) = rest.chars().next() {
        let Some((commit, after)) = rest[flag.len_utf8()..].split_once(' ') else {
            break;
        };
        if !matches!(flag, ' ' | '-' | '+' | 'U')
            || !matches!(commit.len(), 40 | 64)
            || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            break;
        }
        let Some(path) = paths
            .iter()
            .filter(|path| {
                after.strip_prefix(path.as_str()).is_some_and(|tail| {
                    tail.is_empty() || tail.starts_with('\n') || tail.starts_with(" (")
                })
            })
            .max_by_key(|path| path.len())
        else {
            break;
        };
        let tail = &after[path.len()..];
        rest = match tail.find('\n') {
            Some(index) => &tail[index + 1..],
            None => "",
        };
        let state = match flag {
            '-' => "uninitialized",
            '+' => "modified",
            'U' => "conflicted",
            _ => "clean",
        };
        items.push((state.into(), commit.into(), path.clone()));
    }
    items
}

pub fn list_submodules(repo: &Repository) -> AppResult<Vec<SubmoduleInfo>> {
    let root = workdir(repo)?;
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let (paths, urls) = submodule_config(repo);
    let stdout = run_git_stdout(root, &["-c", "core.quotePath=off", "submodule", "status"])?;
    Ok(
        parse_submodule_status(&String::from_utf8_lossy(&stdout), &paths)
            .into_iter()
            .map(|(state, commit, path)| SubmoduleInfo {
                url: urls.get(&path).cloned(),
                commit: Some(commit).filter(|commit| !commit.is_empty()),
                state,
                path,
            })
            .collect(),
    )
}

fn submodule_config(repo: &Repository) -> (Vec<String>, HashMap<String, String>) {
    let options = ["config", "--null", "--file", ".gitmodules"];
    let mut names_args = options.to_vec();
    names_args.extend(["--name-only", "--get-regexp", r"^submodule\."]);
    let Ok(names) = run_git_stdout(repo.workdir(), &names_args) else {
        return (Vec::new(), HashMap::new());
    };
    let mut values_args = options.to_vec();
    values_args.extend(["--get-regexp", r"^submodule\."]);
    let Ok(values) = run_git_stdout(repo.workdir(), &values_args) else {
        return (Vec::new(), HashMap::new());
    };
    let names: Vec<_> = names
        .split(|byte| *byte == 0)
        .filter(|key| !key.is_empty())
        .collect();
    let mut paths = HashMap::new();
    let mut urls = HashMap::new();
    for record in values.split(|byte| *byte == 0) {
        // Match complete keys so a newline inside a path remains part of its value.
        let Some(key) = names
            .iter()
            .filter(|key| record.starts_with(key) && record.get(key.len()) == Some(&b'\n'))
            .max_by_key(|key| key.len())
        else {
            continue;
        };
        let key_text = String::from_utf8_lossy(key);
        let Some(name) = key_text.strip_prefix("submodule.") else {
            continue;
        };
        let value = String::from_utf8_lossy(&record[key.len() + 1..]).into_owned();
        if let Some(name) = name.strip_suffix(".path") {
            paths.insert(name.to_string(), to_git_path(&value));
        } else if let Some(name) = name.strip_suffix(".url") {
            urls.insert(name.to_string(), value);
        }
    }
    let mut known_paths: Vec<_> = paths.values().cloned().collect();
    known_paths.sort();
    known_paths.dedup();
    let urls = paths
        .into_iter()
        .filter_map(|(name, path)| urls.get(&name).map(|url| (path, url.clone())))
        .collect();
    (known_paths, urls)
}

/// Initializes and checks out submodules at their recorded commits, nested
/// ones included. An empty `paths` updates them all.
pub fn update_submodules(
    repo: &mut Repository,
    paths: &[String],
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let mut args = vec!["submodule", "update", "--init", "--recursive", "--progress"];
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if !specs.is_empty() {
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
    }
    run_git_ok_progress(workdir(repo)?, &args, on_progress)?;
    snapshot(repo)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` would remove the entry.
    pub prunable: bool,
    /// The worktree this repository was opened from.
    pub current: bool,
    /// The repository's main working tree.
    pub main: bool,
}

pub(super) fn parse_worktree_list(text: &str) -> Vec<WorktreeInfo> {
    let mut items = Vec::new();
    for (index, record) in text
        .split("\0\0")
        .filter(|record| !record.is_empty())
        .enumerate()
    {
        let mut item = WorktreeInfo {
            path: String::new(),
            head: None,
            branch: None,
            detached: false,
            locked: false,
            prunable: false,
            current: false,
            main: index == 0,
        };
        for line in record.split('\0') {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => item.path = value.to_string(),
                "HEAD" => item.head = Some(value.to_string()),
                "branch" => item.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                "detached" => item.detached = true,
                "locked" => item.locked = true,
                "prunable" => item.prunable = true,
                _ => {}
            }
        }
        if !item.path.is_empty() {
            items.push(item);
        }
    }
    items
}

fn same_folder(left: &str, right: &Path) -> bool {
    let left = Path::new(left);
    let left = strip_verbatim_path(left.canonicalize().unwrap_or_else(|_| left.to_path_buf()));
    let right = strip_verbatim_path(right.canonicalize().unwrap_or_else(|_| right.to_path_buf()));
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

pub fn list_worktrees(repo: &Repository) -> AppResult<Vec<WorktreeInfo>> {
    let root = workdir_owned(repo)?;
    let stdout = run_git_stdout(&root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut items = parse_worktree_list(&String::from_utf8_lossy(&stdout));
    for item in &mut items {
        item.current = same_folder(&item.path, &root);
    }
    Ok(items)
}

/// Creates a worktree at `path`, checking out `branch`, or a new branch
/// `new_branch` started from `start` (HEAD when empty).
pub fn add_worktree(
    repo: &Repository,
    path: &str,
    branch: Option<&str>,
    new_branch: Option<&str>,
    start: Option<&str>,
) -> AppResult<String> {
    if path.is_empty() {
        return Err(AppError::msg("Choose a folder for the worktree"));
    }
    let mut args = vec!["worktree", "add"];
    let new_branch = new_branch.map(str::trim).filter(|name| !name.is_empty());
    if let Some(name) = new_branch {
        args.extend(["-b", name]);
    }
    args.extend(["--", path]);
    match (
        new_branch,
        branch.map(str::trim).filter(|name| !name.is_empty()),
    ) {
        (None, Some(branch)) => args.push(branch),
        (Some(_), _) => {
            if let Some(start) = start.map(str::trim).filter(|start| !start.is_empty()) {
                args.push(start);
            }
        }
        (None, None) => return Err(AppError::msg("Choose a branch or name a new one")),
    }
    run_git_stdout(workdir(repo)?, &args)?;
    let created = PathBuf::from(path);
    let created = if created.is_absolute() {
        created
    } else {
        workdir(repo)?.join(created)
    };
    Ok(strip_verbatim_prefix(
        &created.canonicalize().unwrap_or(created).to_string_lossy(),
    ))
}

pub fn remove_worktree(repo: &Repository, path: &str, force: bool) -> AppResult<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", path]);
    run_git_stdout(workdir(repo)?, &args)?;
    Ok(())
}

pub fn prune_worktrees(repo: &Repository) -> AppResult<()> {
    run_git_stdout(workdir(repo)?, &["worktree", "prune"])?;
    Ok(())
}

#[cfg(test)]
mod structure_tests {
    use super::*;

    fn repository(path: &Path) -> Repository {
        fs::create_dir_all(path).unwrap();
        run_git_stdout(path, &["init", "-q"]).unwrap();
        run_git_stdout(path, &["config", "user.name", "Alice"]).unwrap();
        run_git_stdout(path, &["config", "user.email", "alice@example.com"]).unwrap();
        fs::write(path.join("file.txt"), "base\n").unwrap();
        run_git_stdout(path, &["add", "file.txt"]).unwrap();
        run_git_stdout(path, &["-c", "core.hooksPath=", "commit", "-qm", "base"]).unwrap();
        open_at(path).unwrap()
    }

    #[test]
    fn relative_worktrees_return_the_absolute_repo_relative_destination() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("main"));
        let created =
            add_worktree(&repo, "nested/worktree space", None, Some("side"), None).unwrap();
        let expected = repo
            .workdir()
            .join("nested/worktree space")
            .canonicalize()
            .unwrap();
        assert!(Path::new(&created).is_absolute());
        assert!(same_folder(&created, &expected));
        let trees = list_worktrees(&repo).unwrap();
        // Git and the native filesystem may use different Windows separators.
        assert!(
            trees
                .iter()
                .any(|tree| same_folder(&tree.path, Path::new(&created))
                    && tree.branch.as_deref() == Some("side")
                    && !tree.current
                    && !tree.main),
            "created={created:?}, trees={trees:#?}"
        );
        assert!(trees.iter().any(|tree| tree.main && tree.current));
        let linked = open_at(Path::new(&created)).unwrap();
        let linked_trees = list_worktrees(&linked).unwrap();
        assert!(
            linked_trees.iter().any(|tree| tree.current
                && !tree.main
                && tree.branch.as_deref() == Some("side")
                && same_folder(&tree.path, Path::new(&created))),
            "created={created:?}, linked_trees={linked_trees:#?}"
        );
        assert!(linked_trees
            .iter()
            .any(|tree| tree.main && !tree.current && same_folder(&tree.path, repo.workdir())));
        drop(linked);
        fs::write(Path::new(&created).join("file.txt"), "dirty\n").unwrap();
        assert!(remove_worktree(&repo, &created, false).is_err());
        assert!(Path::new(&created).join("file.txt").is_file());
        remove_worktree(&repo, &created, true).unwrap();
        assert!(!Path::new(&created).exists());
        assert!(ref_exists(&repo, "refs/heads/side"));
        assert_eq!(list_worktrees(&repo).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn worktree_paths_keep_newlines_backslashes_and_trailing_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("main"));
        for (index, name) in [
            " worktree\nwith\\literal ",
            "trailing-newline\n",
            "trailing-carriage-return\r",
        ]
        .into_iter()
        .enumerate()
        {
            let path = temp.path().join(name);
            let branch = format!("side-{index}");
            let created =
                add_worktree(&repo, path.to_str().unwrap(), None, Some(&branch), None).unwrap();
            assert_eq!(Path::new(&created), path.canonicalize().unwrap());
            let trees = list_worktrees(&repo).unwrap();
            assert_eq!(trees.len(), 2);
            assert_eq!(trees[1].path, created);
            let linked = open_at(Path::new(&created)).unwrap();
            assert!(list_worktrees(&linked).unwrap()[1].current);
            drop(linked);
            remove_worktree(&repo, &created, false).unwrap();
            assert!(!path.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn submodules_keep_literal_paths_with_explicit_config_names() {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("source");
        let _source = repository(&source_path);
        let repo = repository(&temp.path().join("main"));
        let path = "libs/space \\and\nnewline";
        run_git_stdout(
            repo.workdir(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--name",
                "portable-module",
                source_path.to_str().unwrap(),
                path,
            ],
        )
        .unwrap();
        let modules = list_submodules(&repo).unwrap();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].path, path);
        assert_eq!(modules[0].state, "clean");
        assert_eq!(modules[0].url.as_deref(), source_path.to_str());
        assert!(open_at(&repo.workdir().join(&modules[0].path)).is_ok());
        run_git_stdout(repo.workdir(), &["submodule", "deinit", "-f", "--", path]).unwrap();
        let modules = list_submodules(&repo).unwrap();
        assert_eq!(modules[0].path, path);
        assert_eq!(modules[0].state, "uninitialized");
    }
}
