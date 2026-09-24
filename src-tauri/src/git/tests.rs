use super::*;

fn temp_repo() -> (PathBuf, Repository) {
    let root = std::env::temp_dir().join(format!(
        "rebasely-stash-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let repo = Repository::init(&root).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Rebasely Test").unwrap();
    config.set_str("user.email", "test@example.com").unwrap();
    (root, repo)
}

#[test]
fn stash_diff_includes_tracked_and_untracked_files() {
    let (root, mut repo) = temp_repo();
    fs::write(root.join("tracked.txt"), "base\n").unwrap();
    fs::write(root.join("gone.txt"), "remove me\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("tracked.txt")).unwrap();
    index.add_path(Path::new("gone.txt")).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    drop(index);
    {
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "init", &tree, &[])
            .unwrap();
    }

    fs::write(root.join("tracked.txt"), "changed\n").unwrap();
    fs::remove_file(root.join("gone.txt")).unwrap();
    fs::write(root.join("extra.txt"), "new\n").unwrap();
    stash_save(&mut repo, "wip", true).unwrap();

    let mut id = String::new();
    repo.stash_foreach(|index, _, oid| {
        if index == 0 {
            id = oid.to_string();
        }
        true
    })
    .unwrap();

    let details = stash_details(&repo, &id).unwrap();
    let kind = |path: &str| {
        details
            .files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.kind.as_str())
    };
    assert_eq!(kind("tracked.txt"), Some("modified"), "{:?}", details.files);
    assert_eq!(kind("gone.txt"), Some("deleted"), "{:?}", details.files);
    assert_eq!(kind("extra.txt"), Some("untracked"), "{:?}", details.files);

    let tracked = stash_file_diff(&repo, &id, "tracked.txt").unwrap();
    assert!(tracked.lines.iter().any(|line| line.content.contains("changed")));
    let extra = stash_file_diff(&repo, &id, "extra.txt").unwrap();
    assert!(
        extra
            .lines
            .iter()
            .any(|line| line.kind == "add" && line.content.contains("new")),
        "{:?}",
        extra.lines
    );

    let _ = fs::remove_dir_all(&root);
}

fn commit_file(repo: &mut Repository, root: &Path, name: &str, body: &str, message: &str) {
    fs::write(root.join(name), body).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    drop(index);
    let tree = repo.find_tree(tree_id).unwrap();
    let signature = repo.signature().unwrap();
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let parents: Vec<_> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .unwrap();
}

fn head_summary(repo: &Repository) -> String {
    repo.head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .summary()
        .unwrap_or("")
        .to_string()
}

#[test]
fn rebase_onto_replays_commits() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "base.txt", "base\n", "base");
    repo.branch("feature", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "main.txt", "main\n", "main-tip");
    repo.set_head("refs/heads/feature").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    commit_file(&mut repo, &root, "feature.txt", "one\n", "feature-one");
    commit_file(&mut repo, &root, "feature.txt", "two\n", "feature-two");

    let onto = {
        let main = repo
            .find_branch("main", BranchType::Local)
            .or_else(|_| repo.find_branch("master", BranchType::Local))
            .unwrap();
        main.get().target().unwrap().to_string()
    };
    rebase_onto(&mut repo, &onto).unwrap();
    assert_eq!(head_summary(&repo), "feature-two");
    assert!(root.join("main.txt").exists());
    assert!(rebase_progress(&repo).is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn interactive_rebase_can_reword_and_drop() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "a\n", "base");
    let onto = repo.head().unwrap().target().unwrap().to_string();
    commit_file(&mut repo, &root, "file.txt", "b\n", "keep");
    let keep = repo.head().unwrap().target().unwrap().to_string();
    commit_file(&mut repo, &root, "file.txt", "c\n", "change-me");
    let change = repo.head().unwrap().target().unwrap().to_string();
    commit_file(&mut repo, &root, "file.txt", "d\n", "drop-me");
    let drop = repo.head().unwrap().target().unwrap().to_string();

    rebase_interactive(
        &mut repo,
        &onto,
        &[
            RebaseStep {
                id: keep,
                action: "pick".to_string(),
                message: String::new(),
            },
            RebaseStep {
                id: change,
                action: "reword".to_string(),
                message: "rewritten".to_string(),
            },
            RebaseStep {
                id: drop,
                action: "drop".to_string(),
                message: String::new(),
            },
        ],
    )
    .unwrap();
    assert_eq!(head_summary(&repo), "rewritten");
    let log = run_git_stdout(&root, &["log", "--format=%s"]).unwrap();
    let text = String::from_utf8_lossy(&log);
    assert!(text.contains("keep"));
    assert!(!text.contains("drop-me"));
    assert!(!text.contains("change-me"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rebase_conflict_can_abort() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "left\n", "left");
    repo.set_head("refs/heads/other").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "right\n", "right");
    let original = repo.head().unwrap().target().unwrap();
    let onto = {
        let main = repo
            .find_branch("main", BranchType::Local)
            .or_else(|_| repo.find_branch("master", BranchType::Local))
            .unwrap();
        main.get().target().unwrap().to_string()
    };
    let err = rebase_onto(&mut repo, &onto).unwrap_err();
    assert!(err.to_string().contains("conflicts"), "{err}");
    assert!(rebase_progress(&repo).is_some());
    rebase_abort(&mut repo).unwrap();
    assert!(rebase_progress(&repo).is_none());
    assert_eq!(repo.head().unwrap().target().unwrap(), original);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rebase_conflict_can_continue() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "left\n", "left");
    repo.set_head("refs/heads/other").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "right\n", "right");
    let onto = {
        let main = repo
            .find_branch("main", BranchType::Local)
            .or_else(|_| repo.find_branch("master", BranchType::Local))
            .unwrap();
        main.get().target().unwrap().to_string()
    };
    assert!(rebase_onto(&mut repo, &onto).is_err());
    fs::write(root.join("file.txt"), "both\n").unwrap();
    run_git_stdout(&root, &["add", "file.txt"]).unwrap();
    rebase_continue(&mut repo).unwrap();
    assert!(rebase_progress(&repo).is_none());
    assert_eq!(head_summary(&repo), "right");
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "both\n");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn reset_can_move_to_a_commit_on_another_branch() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    let current = repo.head().unwrap().name().unwrap().to_string();
    repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "left\n", "left");
    let other_tip = {
        repo.set_head("refs/heads/other").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        commit_file(&mut repo, &root, "other.txt", "side\n", "side");
        let tip = repo.head().unwrap().target().unwrap();
        repo.set_head(&current).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        tip
    };
    reset_to_commit(&mut repo, &other_tip.to_string(), "hard").unwrap();
    assert_eq!(repo.head().unwrap().target().unwrap(), other_tip);
    assert_eq!(head_summary(&repo), "side");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn merge_conflict_can_take_ours_and_continue() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "left\n", "left");
    let incoming = repo.head().unwrap().target().unwrap().to_string();
    repo.set_head("refs/heads/other").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "right\n", "right");
    assert!(merge_ref(&mut repo, &incoming).unwrap_err().to_string().contains("conflicts"));
    assert_eq!(git_operation(&repo).unwrap().kind, "merge");
    resolve_conflict(&mut repo, "file.txt", "ours").unwrap();
    operation_continue(&mut repo).unwrap();
    assert!(git_operation(&repo).is_none());
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap().replace("\r\n", "\n"),
        "right\n"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn amend_keeps_original_author() {
    let (root, repo) = temp_repo();
    fs::write(root.join("a.txt"), "a\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let author = git2::Signature::now("Original Author", "author@example.com").unwrap();
        let committer = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &author, &committer, "first", &tree, &[])
            .unwrap();
    }
    commit(&repo, "reworded", true).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.summary(), Some("reworded"));
    assert_eq!(head.author().name(), Some("Original Author"));
    assert_eq!(head.committer().name(), Some("Rebasely Test"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn merge_commit_lists_files_against_first_parent() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "base.txt", "base\n", "base");
    let main_ref = repo.head().unwrap().name().unwrap().to_string();
    repo.branch("side", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "main.txt", "main\n", "main");
    repo.set_head("refs/heads/side").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    commit_file(&mut repo, &root, "side.txt", "side\n", "side");
    let side_tip = repo.head().unwrap().target().unwrap().to_string();
    repo.set_head(&main_ref).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    merge_ref(&mut repo, &side_tip).unwrap();

    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    let details = commit_details(&repo, &head.id().to_string()).unwrap();
    let paths: Vec<_> = details.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, vec!["side.txt"]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn discard_restores_tracked_and_removes_new_files() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "tracked.txt", "base\n", "base");
    commit_file(&mut repo, &root, "odd[1].txt", "base\n", "odd");
    fs::write(root.join("tracked.txt"), "changed\n").unwrap();
    fs::write(root.join("odd[1].txt"), "changed\n").unwrap();
    fs::write(root.join("staged-new.txt"), "new\n").unwrap();
    fs::write(root.join("untracked.txt"), "loose\n").unwrap();
    stage_paths(&repo, &["tracked.txt".into(), "staged-new.txt".into()]).unwrap();

    discard_paths(
        &repo,
        &[
            "tracked.txt".into(),
            "odd[1].txt".into(),
            "staged-new.txt".into(),
            "untracked.txt".into(),
        ],
    )
    .unwrap();

    let read = |name: &str| fs::read_to_string(root.join(name)).unwrap().replace("\r\n", "\n");
    assert_eq!(read("tracked.txt"), "base\n");
    assert_eq!(read("odd[1].txt"), "base\n");
    assert!(!root.join("staged-new.txt").exists());
    assert!(!root.join("untracked.txt").exists());
    let status = status_from_libgit2(&repo).unwrap();
    assert!(status.staged.is_empty(), "{:?}", status.staged);
    assert!(status.unstaged.is_empty(), "{:?}", status.unstaged);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn safe_repo_path_rejects_escapes() {
    assert_eq!(safe_repo_path("src\\main.rs").unwrap(), "src/main.rs");
    assert_eq!(safe_repo_path("/src/").unwrap(), "src");
    assert!(safe_repo_path("../secret").is_err());
    assert!(safe_repo_path("a/./b").is_err());
    if cfg!(windows) {
        assert!(safe_repo_path("C:/Windows/win.ini").is_err());
        assert!(safe_repo_path("C:foo").is_err());
        assert!(safe_repo_path("file.txt:stream").is_err());
    }
}

#[test]
fn pathspec_chunks_split_long_lists() {
    let paths: Vec<String> = (0..3000).map(|n| format!("dir/file-{n:05}.txt")).collect();
    let chunks = pathspec_chunks(&paths);
    assert!(chunks.len() > 1);
    assert_eq!(chunks.iter().map(|chunk| chunk.len()).sum::<usize>(), paths.len());
    assert!(pathspec_chunks(&[]).is_empty());
}
