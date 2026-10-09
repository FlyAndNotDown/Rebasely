use super::*;

fn temp_repo() -> (PathBuf, Repository) {
    // Tests run in parallel and the clock is too coarse to tell them apart.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "rebasely-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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
    stash_save(&mut repo, "wip", true, &[]).unwrap();

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

    let tracked = stash_file_diff(&repo, &id, "tracked.txt", false).unwrap();
    assert!(tracked.lines.iter().any(|line| line.content.contains("changed")));
    let extra = stash_file_diff(&repo, &id, "extra.txt", false).unwrap();
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
    let prepared = git_operation(&repo).unwrap().message.unwrap();
    assert!(prepared.starts_with("Merge commit"), "{prepared}");
    assert!(!prepared.contains("Conflicts"), "{prepared}");
    resolve_conflict(&mut repo, "file.txt", "ours").unwrap();
    operation_continue(&mut repo, None).unwrap();
    assert!(git_operation(&repo).is_none());
    assert_eq!(head_summary(&repo), prepared.lines().next().unwrap());
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

#[test]
fn stash_actions_follow_the_id_after_indexes_shift() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    fs::write(root.join("file.txt"), "first\n").unwrap();
    stash_save(&mut repo, "first", false, &[]).unwrap();
    let first = list_stashes(&mut repo).unwrap()[0].id.clone();
    fs::write(root.join("file.txt"), "second\n").unwrap();
    stash_save(&mut repo, "second", false, &[]).unwrap();

    // "first" is now stash@{1}; dropping by id must not touch "second".
    stash_drop(&mut repo, &first).unwrap();
    let left = list_stashes(&mut repo).unwrap();
    assert_eq!(left.len(), 1);
    assert!(left[0].message.contains("second"), "{:?}", left[0].message);
    assert!(stash_apply(&mut repo, &first).is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn file_history_follows_a_rename() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "old.txt", "one\ntwo\nthree\nfour\n", "add old");
    commit_file(&mut repo, &root, "old.txt", "one\ntwo\nthree\nfour\nfive\n", "edit old");
    run_git_stdout(&root, &["mv", "old.txt", "new name.txt"]).unwrap();
    run_git_stdout(&root, &["commit", "-q", "-m", "rename"]).unwrap();

    let commits = file_commits(&repo, "new name.txt", 10, 0).unwrap();
    let seen: Vec<_> = commits
        .iter()
        .map(|commit| (commit.summary.as_str(), commit.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(
        seen,
        vec![("rename", "new name.txt"), ("edit old", "old.txt"), ("add old", "old.txt")]
    );
    let paged = file_commits(&repo, "new name.txt", 1, 1).unwrap();
    assert_eq!(paged[0].path.as_deref(), Some("old.txt"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn blame_of_a_file_not_in_head_is_empty_but_other_failures_surface() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "tracked.txt", "a\n", "base");
    fs::write(root.join("loose.txt"), "b\n").unwrap();
    assert!(file_blame(&repo, "loose.txt").unwrap().is_empty());
    assert_eq!(file_blame(&repo, "tracked.txt").unwrap().len(), 1);
    fs::create_dir_all(root.join("dir")).unwrap();
    assert!(file_blame(&repo, "../outside.txt").is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn porcelain_status_splits_staged_unstaged_renames_and_conflicts() {
    let raw = b" M a.txt\0M  b.txt\0MM c.txt\0R  new.txt\0old.txt\0?? dir/u.txt\0UU both.txt\0AA added.txt\0 D gone.txt\0";
    let status = parse_porcelain(raw).unwrap();
    let staged: Vec<_> = status
        .staged
        .iter()
        .map(|file| (file.path.as_str(), file.old_path.as_deref(), file.kind.as_str()))
        .collect();
    assert_eq!(
        staged,
        vec![
            ("b.txt", None, "modified"),
            ("c.txt", None, "modified"),
            ("new.txt", Some("old.txt"), "renamed"),
        ]
    );
    let unstaged: Vec<_> = status
        .unstaged
        .iter()
        .map(|file| (file.path.as_str(), file.kind.as_str()))
        .collect();
    assert_eq!(
        unstaged,
        vec![
            ("a.txt", "modified"),
            ("c.txt", "modified"),
            ("dir/u.txt", "untracked"),
            ("both.txt", "conflicted"),
            ("added.txt", "conflicted"),
            ("gone.txt", "deleted"),
        ]
    );
}

#[test]
fn staged_rename_is_listed_under_its_new_name() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "old.txt", "one\ntwo\nthree\nfour\n", "base");
    run_git_stdout(&root, &["mv", "old.txt", "new.txt"]).unwrap();
    let status = status_from_git(&root).unwrap();
    assert_eq!(status.staged.len(), 1, "{:?}", status.staged);
    assert_eq!(status.staged[0].path, "new.txt");
    assert_eq!(status.staged[0].old_path.as_deref(), Some("old.txt"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn git_log_parser_reads_fields_and_parents() {
    let raw = b"aaaaaaa1\0aaaaaaa\0Merge side\0Ann\0ann@x\x001700000000\0bbbbbbb1 ccccccc1\n\
                bbbbbbb1\0bbbbbbb\0Root\0Bob\0bob@x\x001600000000\0\n";
    let commits = parse_git_log(raw).unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].summary, "Merge side");
    assert_eq!(commits[0].parents, vec!["bbbbbbb1", "ccccccc1"]);
    assert_eq!(commits[0].timestamp, 1_700_000_000);
    assert!(commits[1].parents.is_empty());
}

#[test]
fn blame_parser_merges_runs_and_skips_uncommitted_lines() {
    let first = "1".repeat(40);
    let second = "2".repeat(40);
    let zero = "0".repeat(40);
    let raw = format!(
        "{first} 1 1 2\nauthor Alice\nauthor-mail <a@x>\nauthor-time 100\nauthor-tz +0000\nsummary one\nfilename a.txt\n\tline one\n\
         {first} 2 2\n\tline two\n\
         {zero} 3 3 1\nauthor Not Committed Yet\nauthor-time 0\nfilename a.txt\n\tline three\n\
         {second} 4 4 1\nauthor Bob\nauthor-time 200\nfilename a.txt\n\tline four\n"
    );
    let hunks = parse_blame_porcelain(raw.as_bytes());
    let seen: Vec<_> = hunks
        .iter()
        .map(|hunk| (hunk.start, hunk.count, hunk.author.as_str(), hunk.time))
        .collect();
    assert_eq!(seen, vec![(0, 2, "Alice", 100), (3, 1, "Bob", 200)]);
}

#[test]
fn name_status_parser_reads_renames_old_path_first() {
    let files = parse_name_status_z(b"M\0a.txt\0R100\0old.txt\0new.txt\0A\0img.png\0").unwrap();
    let seen: Vec<_> = files
        .iter()
        .map(|file| (file.path.as_str(), file.old_path.as_deref(), file.kind.as_str(), file.binary))
        .collect();
    assert_eq!(
        seen,
        vec![
            ("a.txt", None, "modified", false),
            ("new.txt", Some("old.txt"), "renamed", false),
            ("img.png", None, "added", true),
        ]
    );
}

#[test]
fn keeping_both_sides_drops_markers_and_the_diff3_base() {
    let plain = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nz\n";
    assert_eq!(take_both_sides(plain).as_deref(), Some("a\nours\ntheirs\nz\n"));
    let diff3 = "<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> side\n";
    assert_eq!(take_both_sides(diff3).as_deref(), Some("ours\ntheirs\n"));
    assert_eq!(take_both_sides("no markers\n"), None);
}

#[test]
fn history_pages_are_contiguous_whether_or_not_the_stream_is_reused() {
    let (root, mut repo) = temp_repo();
    for n in 0..10 {
        commit_file(&mut repo, &root, "file.txt", &format!("{n}\n"), &format!("c{n}"));
    }
    let page = |skip| {
        commits(&repo, 3, skip, None, &[])
            .unwrap()
            .into_iter()
            .map(|commit| commit.summary)
            .collect::<Vec<_>>()
    };
    let mut seen = page(0);
    seen.extend(page(3));
    seen.extend(page(6));
    seen.extend(page(9));
    assert_eq!(seen, (0..10).rev().map(|n| format!("c{n}")).collect::<Vec<_>>());
    // Out of order: the open stream is at 12, so this restarts and reads through.
    assert_eq!(page(3), vec!["c6", "c5", "c4"]);
    assert!(page(10).is_empty());
    retain_log_streams(&[]);
    let _ = fs::remove_dir_all(&root);
}

/// `REBASELY_BENCH_REPO=<path> cargo test bench_history_pages -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_history_pages() {
    let Ok(path) = std::env::var("REBASELY_BENCH_REPO") else { return };
    let mut repo = open_at(Path::new(&path)).unwrap();
    for skip in [0, 80, 160, 240] {
        let started = std::time::Instant::now();
        let items = commits(&repo, 80, skip, None, &[]).unwrap();
        println!("skip={skip}: {} commits in {:?}", items.len(), started.elapsed());
    }
    let started = std::time::Instant::now();
    snapshot(&mut repo).unwrap();
    println!("snapshot: {:?}", started.elapsed());
    let started = std::time::Instant::now();
    for _ in 0..50 {
        let repo = open_at(Path::new(&path)).unwrap();
        let _ = repo.head().unwrap().target();
    }
    println!("open + head: {:?} each", started.elapsed() / 50);
}

#[test]
fn follow_log_parser_tracks_names_across_records() {
    let raw = "\u{1e}aaaaaaa\0aaaaaaa\0rename\0A\0a@x\x001\0bbbbbbb\0\nR100\0old.txt\0new.txt\0\
               \u{1e}bbbbbbb\0bbbbbbb\0merge\0A\0a@x\x000\0ccccccc ddddddd\0\
               \u{1e}ccccccc\0ccccccc\0edit\0A\0a@x\x000\0\0\nM\0old.txt\0";
    let commits = parse_follow_log(raw.as_bytes(), "new.txt");
    let paths: Vec<_> = commits.iter().map(|commit| commit.path.clone().unwrap()).collect();
    assert_eq!(paths, vec!["new.txt", "old.txt", "old.txt"]);
    assert_eq!(commits[1].parents.len(), 2);
}

/// A clean/smudge pair standing in for Git LFS: the index stores `CLEAN` and the
/// working tree reads `smudged`, so either side shows whether git ran the filter.
fn use_test_filter(repo: &Repository, root: &Path) {
    let mut config = repo.config().unwrap();
    config
        .set_str("filter.probe.clean", "sed -e s/plain/CLEAN/ -e s/smudged/CLEAN/")
        .unwrap();
    config.set_str("filter.probe.smudge", "sed s/CLEAN/smudged/").unwrap();
    fs::write(root.join(".gitattributes"), "*.dat filter=probe\n").unwrap();
}

fn blob_text(repo: &Repository, spec: &str) -> String {
    let bytes = run_git_stdout(repo.workdir().unwrap(), &["cat-file", "blob", spec]).unwrap();
    String::from_utf8_lossy(&bytes).replace("\r\n", "\n")
}

fn workdir_text(root: &Path, name: &str) -> String {
    fs::read_to_string(root.join(name)).unwrap().replace("\r\n", "\n")
}

#[test]
fn staging_and_committing_run_the_clean_filter() {
    let (root, mut repo) = temp_repo();
    use_test_filter(&repo, &root);
    fs::write(root.join("asset.dat"), "plain\n").unwrap();
    stage_paths(&repo, &[".gitattributes".into(), "asset.dat".into()]).unwrap();
    assert_eq!(blob_text(&repo, ":asset.dat"), "CLEAN\n");
    commit(&repo, "add asset", false).unwrap();
    assert_eq!(blob_text(&repo, "HEAD:asset.dat"), "CLEAN\n");
    let _ = snapshot(&mut repo).unwrap();
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn checkout_runs_the_smudge_filter() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "readme.txt", "base\n", "base");
    create_branch(&repo, "assets", true, None).unwrap();
    use_test_filter(&repo, &root);
    fs::write(root.join("asset.dat"), "plain\n").unwrap();
    stage_paths(&repo, &[".gitattributes".into(), "asset.dat".into()]).unwrap();
    commit(&repo, "add asset", false).unwrap();

    let main = repo
        .branches(Some(BranchType::Local))
        .unwrap()
        .flatten()
        .map(|(branch, _)| branch.name().unwrap().unwrap().to_string())
        .find(|name| name != "assets")
        .unwrap();
    checkout_branch(&repo, &main).unwrap();
    assert!(!root.join("asset.dat").exists());
    checkout_branch(&repo, "assets").unwrap();
    assert_eq!(workdir_text(&root, "asset.dat"), "smudged\n");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn stash_round_trip_runs_both_filters() {
    let (root, mut repo) = temp_repo();
    use_test_filter(&repo, &root);
    fs::write(root.join("asset.dat"), "plain\n").unwrap();
    stage_paths(&repo, &[".gitattributes".into(), "asset.dat".into()]).unwrap();
    commit(&repo, "add asset", false).unwrap();
    fs::write(root.join("asset.dat"), "plain\nplain\n").unwrap();

    stash_save(&mut repo, "wip", false, &[]).unwrap();
    let id = list_stashes(&mut repo).unwrap()[0].id.clone();
    assert_eq!(blob_text(&repo, &format!("{id}:asset.dat")), "CLEAN\nCLEAN\n");
    stash_pop(&mut repo, &id).unwrap();
    assert_eq!(workdir_text(&root, "asset.dat"), "smudged\nsmudged\n");
    assert!(list_stashes(&mut repo).unwrap().is_empty());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn stashing_nothing_is_an_error_and_paths_limit_the_stash() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "a.txt", "a\n", "a");
    commit_file(&mut repo, &root, "b.txt", "b\n", "b");
    assert!(stash_save(&mut repo, "empty", false, &[]).is_err());

    fs::write(root.join("a.txt"), "a2\n").unwrap();
    fs::write(root.join("b.txt"), "b2\n").unwrap();
    stash_save(&mut repo, "only a", false, &["a.txt".into()]).unwrap();
    assert_eq!(workdir_text(&root, "a.txt"), "a\n");
    assert_eq!(workdir_text(&root, "b.txt"), "b2\n");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn commit_runs_the_pre_commit_hook() {
    let (root, repo) = temp_repo();
    let hook = repo.path().join("hooks").join("pre-commit");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "#!/bin/sh\necho blocked-by-hook >&2\nexit 1\n").unwrap();
    make_executable(&hook).unwrap();
    fs::write(root.join("a.txt"), "a\n").unwrap();
    stage_paths(&repo, &["a.txt".into()]).unwrap();
    let err = commit(&repo, "first", false).unwrap_err().to_string();
    assert!(err.contains("blocked-by-hook"), "{err}");
    assert!(repo.head().is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn committing_during_a_merge_records_both_parents() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    repo.branch("other", &repo.head().unwrap().peel_to_commit().unwrap(), false)
        .unwrap();
    commit_file(&mut repo, &root, "file.txt", "left\n", "left");
    let incoming = repo.head().unwrap().target().unwrap().to_string();
    checkout_branch(&repo, "other").unwrap();
    commit_file(&mut repo, &root, "file.txt", "right\n", "right");
    assert!(merge_ref(&mut repo, &incoming).is_err());
    resolve_conflict(&mut repo, "file.txt", "ours").unwrap();

    commit(&repo, "merge left", false).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    assert_eq!(head.summary(), Some("merge left"));
    assert!(git_operation(&repo).is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn continuing_a_cherry_pick_with_an_edited_message_keeps_the_author() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    create_branch(&repo, "side", true, None).unwrap();
    fs::write(root.join("file.txt"), "side\n").unwrap();
    stage_paths(&repo, &["file.txt".into()]).unwrap();
    run_git_input(
        &root,
        &["-c", "user.name=Side Author", "-c", "user.email=side@example.com", "commit", "--file=-"],
        b"side change",
    )
    .unwrap();
    let picked = repo.head().unwrap().target().unwrap().to_string();
    let main = repo
        .branches(Some(BranchType::Local))
        .unwrap()
        .flatten()
        .map(|(branch, _)| branch.name().unwrap().unwrap().to_string())
        .find(|name| name != "side")
        .unwrap();
    checkout_branch(&repo, &main).unwrap();
    commit_file(&mut repo, &root, "file.txt", "main\n", "main change");

    assert!(cherry_pick_commit(&mut repo, &picked).is_err());
    assert_eq!(git_operation(&repo).unwrap().message.as_deref(), Some("side change"));
    resolve_conflict(&mut repo, "file.txt", "theirs").unwrap();
    operation_continue(&mut repo, Some("side change, reworded")).unwrap();

    assert!(git_operation(&repo).is_none());
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.summary(), Some("side change, reworded"));
    assert_eq!(head.author().name(), Some("Side Author"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn continuing_a_rebase_with_an_edited_message_uses_it() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    create_branch(&repo, "feature", true, None).unwrap();
    commit_file(&mut repo, &root, "file.txt", "feature\n", "feature change");
    let main = repo
        .branches(Some(BranchType::Local))
        .unwrap()
        .flatten()
        .map(|(branch, _)| branch.name().unwrap().unwrap().to_string())
        .find(|name| name != "feature")
        .unwrap();
    checkout_branch(&repo, &main).unwrap();
    commit_file(&mut repo, &root, "file.txt", "main\n", "main change");
    checkout_branch(&repo, "feature").unwrap();

    assert!(rebase_onto(&mut repo, &main).is_err());
    assert_eq!(git_operation(&repo).unwrap().message.as_deref(), Some("feature change"));
    resolve_conflict(&mut repo, "file.txt", "theirs").unwrap();
    operation_continue(&mut repo, Some("feature change, rebased")).unwrap();

    assert!(git_operation(&repo).is_none());
    assert_eq!(head_summary(&repo), "feature change, rebased");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn conflicts_from_a_stash_apply_can_be_resolved() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "base\n", "base");
    fs::write(root.join("file.txt"), "stashed\n").unwrap();
    stash_save(&mut repo, "wip", false, &[]).unwrap();
    commit_file(&mut repo, &root, "file.txt", "committed\n", "move on");
    let id = list_stashes(&mut repo).unwrap()[0].id.clone();
    assert!(stash_apply(&mut repo, &id).is_err());
    assert!(git_operation(&repo).is_none());
    resolve_conflict(&mut repo, "file.txt", "theirs").unwrap();
    assert_eq!(workdir_text(&root, "file.txt"), "stashed\n");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn cancelling_a_clone_stops_git_and_removes_the_folder() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "a.txt", "a\n", "a");
    let dest = PathBuf::from(format!("{}-clone", root.display()));
    let _ = fs::remove_dir_all(&dest);
    let result = with_cancel(Some("test-cancel-clone"), || {
        assert!(cancel_activity("test-cancel-clone"));
        clone_repository(&root.to_string_lossy(), &dest.to_string_lossy(), |_| {})
    });
    assert!(result.unwrap_err().is_cancelled());
    assert!(!dest.exists());
    assert!(!cancel_activity("test-cancel-clone"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn pull_and_push_follow_an_upstream_with_a_different_name() {
    let (origin_root, mut origin) = temp_repo();
    commit_file(&mut origin, &origin_root, "a.txt", "a\n", "base");
    create_branch(&origin, "feat-x", false, None).unwrap();

    let local_root = PathBuf::from(format!("{}-local", origin_root.display()));
    let _ = fs::remove_dir_all(&local_root);
    clone_repository(&origin_root.to_string_lossy(), &local_root.to_string_lossy(), |_| {}).unwrap();
    let mut local = open_at(&local_root).unwrap();
    {
        let mut config = local.config().unwrap();
        config.set_str("user.name", "Rebasely Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
    }
    run_git_stdout(&local_root, &["switch", "-c", "feature", "--track", "origin/feat-x"]).unwrap();

    origin.set_head("refs/heads/feat-x").unwrap();
    origin
        .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    commit_file(&mut origin, &origin_root, "b.txt", "b\n", "upstream change");
    let upstream_tip = origin.head().unwrap().target().unwrap();
    let main = origin
        .branches(Some(BranchType::Local))
        .unwrap()
        .flatten()
        .map(|(branch, _)| branch.name().unwrap().unwrap().to_string())
        .find(|name| name != "feat-x")
        .unwrap();
    checkout_branch(&origin, &main).unwrap();

    pull_remote(&mut local, Some("origin"), false, |_| {}).unwrap();
    assert_eq!(local.head().unwrap().target().unwrap(), upstream_tip);

    commit_file(&mut local, &local_root, "c.txt", "c\n", "local change");
    let local_tip = local.head().unwrap().target().unwrap();
    push_remote(&mut local, Some("origin"), false, false, |_| {}).unwrap();
    let pushed = origin.find_branch("feat-x", BranchType::Local).unwrap();
    assert_eq!(pushed.get().target().unwrap(), local_tip);
    assert!(origin.find_branch("feature", BranchType::Local).is_err());

    let _ = fs::remove_dir_all(&local_root);
    let _ = fs::remove_dir_all(&origin_root);
}

#[test]
fn ignoring_appends_new_patterns_once_and_hides_the_files() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, ".gitignore", "target/\r\n", "ignore");
    fs::write(root.join("debug.log"), "x\n").unwrap();
    fs::write(root.join("keep.txt"), "x\n").unwrap();
    ignore_patterns(&repo, &["*.log".into(), "target/".into(), "*.log".into()]).unwrap();
    assert_eq!(fs::read_to_string(root.join(".gitignore")).unwrap(), "target/\r\n*.log\r\n");
    let status = status_snapshot(&repo).unwrap();
    let untracked: Vec<_> = status
        .unstaged
        .iter()
        .filter(|file| file.kind == "untracked")
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(untracked, vec!["keep.txt"]);
    let _ = fs::remove_dir_all(&root);
}

fn numbered_lines(count: usize) -> String {
    (1..=count).map(|n| format!("line {n}\n")).collect()
}

/// Picks the changed lines in the displayed diff whose text matches `pick`.
fn pick_lines(repo: &Repository, path: &str, staged: bool, pick: impl Fn(&str) -> bool) -> Vec<LineRef> {
    workdir_diff(repo, path, staged, false)
        .unwrap()
        .lines
        .iter()
        .filter(|line| matches!(line.kind.as_str(), "add" | "delete") && pick(&line.content))
        .map(|line| LineRef {
            old: if line.kind == "delete" { line.old_lineno } else { None },
            new: if line.kind == "add" { line.new_lineno } else { None },
        })
        .collect()
}

#[test]
fn staging_selected_lines_leaves_the_rest_unstaged() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", &numbered_lines(20), "base");
    let edited = numbered_lines(20)
        .replace("line 2\n", "line two\nline two and a half\n")
        .replace("line 15\n", "line fifteen\n");
    fs::write(root.join("file.txt"), &edited).unwrap();

    let lines = pick_lines(&repo, "file.txt", false, |text| text == "line 2" || text == "line two");
    assert_eq!(lines.len(), 2);
    apply_lines(&mut repo, "file.txt", false, "stage", &lines).unwrap();

    let expected_index = numbered_lines(20).replace("line 2\n", "line two\n");
    assert_eq!(blob_text(&repo, ":file.txt"), expected_index);
    assert_eq!(workdir_text(&root, "file.txt"), edited);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn unstaging_and_discarding_selected_lines_touch_only_those_lines() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", &numbered_lines(20), "base");
    let edited = numbered_lines(20)
        .replace("line 2\n", "line two\n")
        .replace("line 15\n", "line fifteen\n");
    fs::write(root.join("file.txt"), &edited).unwrap();
    stage_paths(&repo, &["file.txt".into()]).unwrap();

    let fifteen = pick_lines(&repo, "file.txt", true, |text| text.contains("15") || text.contains("fifteen"));
    apply_lines(&mut repo, "file.txt", true, "unstage", &fifteen).unwrap();
    assert_eq!(
        blob_text(&repo, ":file.txt"),
        numbered_lines(20).replace("line 2\n", "line two\n")
    );

    let unstaged = pick_lines(&repo, "file.txt", false, |_| true);
    apply_lines(&mut repo, "file.txt", false, "discard", &unstaged).unwrap();
    assert_eq!(
        workdir_text(&root, "file.txt"),
        numbered_lines(20).replace("line 2\n", "line two\n")
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn part_of_a_new_file_can_be_staged() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "base.txt", "base\n", "base");
    fs::write(root.join("new.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let diff = workdir_diff(&repo, "new.txt", false, false).unwrap();
    assert_eq!(diff.lines[0].kind, "hunk");
    assert_eq!(diff.lines.len(), 4);

    let picked = pick_lines(&repo, "new.txt", false, |text| text != "beta");
    apply_lines(&mut repo, "new.txt", false, "stage", &picked).unwrap();
    assert_eq!(blob_text(&repo, ":new.txt"), "alpha\ngamma\n");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_last_line_without_a_newline_can_be_staged() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "one\ntwo", "base");
    fs::write(root.join("file.txt"), "one\nTWO").unwrap();
    let picked = pick_lines(&repo, "file.txt", false, |_| true);
    apply_lines(&mut repo, "file.txt", false, "stage", &picked).unwrap();
    assert_eq!(blob_text(&repo, ":file.txt"), "one\nTWO");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn line_actions_work_on_crlf_working_trees() {
    let (root, mut repo) = temp_repo();
    repo.config().unwrap().set_bool("core.autocrlf", true).unwrap();
    fs::write(root.join("file.txt"), numbered_lines(12).replace('\n', "\r\n")).unwrap();
    stage_paths(&repo, &["file.txt".into()]).unwrap();
    commit(&repo, "base", false).unwrap();
    let edited = numbered_lines(12)
        .replace("line 1\n", "line one\n")
        .replace("line 11\n", "line eleven\n")
        .replace('\n', "\r\n");
    fs::write(root.join("file.txt"), &edited).unwrap();

    let first = pick_lines(&repo, "file.txt", false, |text| text.ends_with(" 1") || text == "line one");
    apply_lines(&mut repo, "file.txt", false, "stage", &first).unwrap();
    assert_eq!(blob_text(&repo, ":file.txt"), numbered_lines(12).replace("line 1\n", "line one\n"));

    let rest = pick_lines(&repo, "file.txt", false, |_| true);
    apply_lines(&mut repo, "file.txt", false, "discard", &rest).unwrap();
    let on_disk = fs::read_to_string(root.join("file.txt")).unwrap();
    assert_eq!(on_disk, numbered_lines(12).replace("line 1\n", "line one\n").replace('\n', "\r\n"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn hiding_whitespace_drops_indentation_only_changes() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "fn main() {\nbody();\n}\n", "base");
    fs::write(root.join("file.txt"), "fn main() {\n    body();\n}\n").unwrap();
    let shown = workdir_diff(&repo, "file.txt", false, false).unwrap();
    assert!(shown.lines.iter().any(|line| line.kind == "add"));
    let hidden = workdir_diff(&repo, "file.txt", false, true).unwrap();
    assert!(!hidden.lines.iter().any(|line| line.kind == "add" || line.kind == "delete"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn stale_line_selections_are_rejected() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "file.txt", "one\ntwo\n", "base");
    fs::write(root.join("file.txt"), "one\nTWO\n").unwrap();
    let stale = vec![LineRef { old: Some(40), new: None }];
    let err = apply_lines(&mut repo, "file.txt", false, "stage", &stale).unwrap_err();
    assert!(err.to_string().contains("no longer changes"), "{err}");
    assert!(apply_lines(&mut repo, "file.txt", true, "stage", &stale).is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn image_pairs_read_each_side_and_flag_lfs_pointers() {
    let (root, repo) = temp_repo();
    let png_v1: &[u8] = b"\x89PNG\r\n\x1a\nfirst";
    let png_v2: &[u8] = b"\x89PNG\r\n\x1a\nsecond";
    fs::write(root.join("icon.png"), png_v1).unwrap();
    stage_paths(&repo, &["icon.png".into()]).unwrap();
    commit(&repo, "add icon", false).unwrap();
    fs::write(root.join("icon.png"), png_v2).unwrap();

    let source = ImageSource::Workdir { path: "icon.png".into(), staged: false };
    let pair = image_pair(&repo, &source).unwrap();
    let before = pair.before.unwrap();
    let after = pair.after.unwrap();
    assert!(before.data_url.unwrap().starts_with("data:image/png;base64,"));
    assert_eq!(after.size, png_v2.len() as u64);
    assert!(!after.lfs);

    stage_paths(&repo, &["icon.png".into()]).unwrap();
    commit(&repo, "update icon", false).unwrap();
    let head = repo.head().unwrap().target().unwrap().to_string();
    let source = ImageSource::Commit { oid: head, path: "icon.png".into(), old_path: None };
    let pair = image_pair(&repo, &source).unwrap();
    assert_eq!(pair.before.unwrap().size, png_v1.len() as u64);
    assert_eq!(pair.after.unwrap().size, png_v2.len() as u64);

    let pointer = image_side("big.png", b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n");
    assert!(pointer.lfs && pointer.data_url.is_none());

    fs::write(root.join("new.png"), png_v1).unwrap();
    let source = ImageSource::Workdir { path: "new.png".into(), staged: false };
    let pair = image_pair(&repo, &source).unwrap();
    assert!(pair.before.is_none() && pair.after.is_some());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn tags_go_through_git_and_reject_bad_names() {
    let (root, mut repo) = temp_repo();
    commit_file(&mut repo, &root, "a.txt", "a\n", "a");
    create_tag(&repo, "v1.0", Some("first release"), None).unwrap();
    create_tag(&repo, "light", None, None).unwrap();
    assert!(create_tag(&repo, "bad name", None, None).is_err());
    assert!(create_tag(&repo, "bad..name", None, None).is_err());
    let annotated = repo.revparse_single("v1.0").unwrap();
    assert_eq!(annotated.kind(), Some(ObjectType::Tag));
    assert_eq!(annotated.as_tag().unwrap().message(), Some("first release\n"));
    let _ = fs::remove_dir_all(&root);
}
