use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::error::{AppError, AppResult, GIT_MISSING};

use super::cli::{git_command, git_output_error, require_git};
use super::strip_verbatim_prefix;

const EXISTING_REPOSITORY: &str =
    "This directory is already in a Git repository. Open the existing repository instead.";

pub fn initialize_repository(path: &str, branch: &str) -> AppResult<String> {
    let git = require_git()?;
    initialize_with(path, branch, |root| initialization_command(&git, root))
}

fn initialize_with(
    path: &str,
    branch: &str,
    command: impl Fn(&Path) -> Command,
) -> AppResult<String> {
    if path.trim().is_empty() || !Path::new(path).is_absolute() {
        return Err(AppError::msg(
            "Choose an existing directory using its absolute path.",
        ));
    }
    let root = fs::canonicalize(path)?;
    if !root.is_dir() {
        return Err(AppError::msg("Choose an existing directory."));
    }
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(AppError::msg("Branch name is required."));
    }

    // A marker may be a linked-worktree file or even damaged metadata. Never
    // treat Git's failure to recognize one as permission to initialize over it.
    reject_repository_markers(&root)?;
    let root = PathBuf::from(strip_verbatim_prefix(&root.to_string_lossy()));
    let probe = run(&mut command(&root), &["rev-parse", "--git-dir"])?;
    if probe.status.success() {
        return Err(AppError::msg(EXISTING_REPOSITORY));
    }
    if !String::from_utf8_lossy(&probe.stderr).contains("not a git repository") {
        return Err(git_output_error(probe));
    }
    let valid = run(
        &mut command(&root),
        &["check-ref-format", "--branch", branch],
    )?;
    if !valid.status.success() {
        return Err(git_output_error(valid));
    }

    reject_repository_markers(&root)?;
    let mut initialize = command(&root);
    initialize
        .arg("--git-dir")
        .arg(root.join(".git"))
        .arg("--work-tree")
        .arg(&root);
    let result = run(
        &mut initialize,
        &[
            "-c",
            "core.bare=false",
            "init",
            "--quiet",
            "--initial-branch",
            branch,
            "--",
            ".",
        ],
    )?;
    if !result.status.success() {
        return Err(git_output_error(result));
    }
    Ok(root.to_string_lossy().into_owned())
}

fn reject_repository_markers(root: &Path) -> AppResult<()> {
    for ancestor in root.ancestors() {
        match fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) => return Err(AppError::msg(EXISTING_REPOSITORY)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn initialization_command(git: &Path, root: &Path) -> Command {
    let mut command = git_command(git);
    command.arg("-C").arg(root);
    command.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    // The directory chosen in the dialog owns this operation. Inherited
    // repository-location variables must not redirect metadata or object writes.
    for name in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_SHALLOW_FILE",
        "GIT_CEILING_DIRECTORIES",
    ] {
        command.env_remove(name);
    }
    command
}

fn run(command: &mut Command, args: &[&str]) -> AppResult<Output> {
    command.args(args).output().map_err(|error| {
        if matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
        ) && !crate::locate::is_executable(Path::new(command.get_program()))
        {
            AppError::msg(GIT_MISSING)
        } else {
            AppError::msg(format!("Could not start Git: {error}"))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        temporary: tempfile::TempDir,
        git: PathBuf,
        global: PathBuf,
        templates: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let global = temporary.path().join("global-config");
            fs::write(
                &global,
                "[user]\n\tname = Example Developer\n\temail = alice@example.com\n[init]\n\tdefaultBranch = legacy\n",
            )
            .unwrap();
            let templates = temporary.path().join("templates");
            fs::create_dir(&templates).unwrap();
            Self {
                temporary,
                git: crate::locate::which("git").expect("Git is required for integration tests"),
                global,
                templates,
            }
        }

        fn directory(&self, name: &str) -> PathBuf {
            let path = self.temporary.path().join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn command(&self, root: &Path) -> Command {
            let mut command = initialization_command(&self.git, root);
            command
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", &self.global)
                .env("GIT_CONFIG_COUNT", "0")
                .env("GIT_AUTHOR_NAME", "Example Developer")
                .env("GIT_AUTHOR_EMAIL", "alice@example.com")
                .env("GIT_COMMITTER_NAME", "Example Developer")
                .env("GIT_COMMITTER_EMAIL", "alice@example.com")
                .env_remove("GIT_CONFIG_PARAMETERS")
                .env_remove("GIT_CONFIG")
                .env("GIT_TEMPLATE_DIR", &self.templates);
            command
        }

        fn initialize(&self, path: &Path, branch: &str) -> AppResult<String> {
            initialize_with(&path.to_string_lossy(), branch, |root| self.command(root))
        }

        fn git(&self, root: &Path, args: &[&str]) -> Output {
            run(&mut self.command(root), args).unwrap()
        }
    }

    #[test]
    fn initializes_existing_files_without_staging_committing_or_changing_identity() {
        let fixture = Fixture::new();
        let root = fixture.directory("project with spaces");
        let original = b"existing content\r\n";
        fs::write(root.join("notes.txt"), original).unwrap();
        let global = fs::read(&fixture.global).unwrap();

        let result = fixture.initialize(&root, "main").unwrap();
        assert_eq!(
            Path::new(&result),
            Path::new(&strip_verbatim_prefix(
                &fs::canonicalize(&root).unwrap().to_string_lossy()
            ))
        );
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), original);
        assert_eq!(
            fixture
                .git(&root, &["symbolic-ref", "--short", "HEAD"])
                .stdout,
            b"main\n"
        );
        assert!(fixture.git(&root, &["ls-files", "-z"]).stdout.is_empty());
        assert!(!fixture
            .git(&root, &["rev-parse", "--verify", "HEAD"])
            .status
            .success());
        assert!(!fixture
            .git(&root, &["config", "--local", "user.name"])
            .status
            .success());
        assert!(!fixture
            .git(&root, &["config", "--local", "user.email"])
            .status
            .success());
        assert_eq!(fs::read(&fixture.global).unwrap(), global);
    }

    #[test]
    fn accepts_a_custom_branch_and_rejects_invalid_names_before_writing() {
        let fixture = Fixture::new();
        let root = fixture.directory("custom");
        fixture.initialize(&root, "feature/navigation").unwrap();
        assert_eq!(
            fixture
                .git(&root, &["symbolic-ref", "--short", "HEAD"])
                .stdout,
            b"feature/navigation\n"
        );
        for branch in ["", "bad name", "--bare", "main..other", "@{-1}"] {
            let target = fixture.directory(&format!("invalid-{}", branch.len()));
            assert!(fixture.initialize(&target, branch).is_err(), "{branch}");
            assert!(!target.join(".git").exists());
        }
    }

    #[test]
    fn rejects_missing_paths_files_and_relative_paths() {
        let fixture = Fixture::new();
        assert!(fixture
            .initialize(&fixture.temporary.path().join("missing"), "main")
            .is_err());
        let file = fixture.temporary.path().join("file.txt");
        fs::write(&file, "keep me").unwrap();
        assert!(fixture.initialize(&file, "main").is_err());
        assert!(initialize_with("relative", "main", |root| fixture.command(root)).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "keep me");
    }

    #[test]
    fn rejects_existing_repositories_nested_paths_and_metadata_directories() {
        let fixture = Fixture::new();
        let root = fixture.directory("existing");
        fixture.initialize(&root, "original").unwrap();
        let head = fs::read(root.join(".git/HEAD")).unwrap();
        let nested = root.join("nested/deep");
        fs::create_dir_all(&nested).unwrap();
        for target in [&root, &nested, &root.join(".git")] {
            assert_eq!(
                fixture.initialize(target, "main").unwrap_err().to_string(),
                EXISTING_REPOSITORY
            );
        }
        assert!(!nested.join(".git").exists());
        assert_eq!(fs::read(root.join(".git/HEAD")).unwrap(), head);
    }

    #[test]
    fn rejects_bare_repositories_and_linked_worktree_markers() {
        let fixture = Fixture::new();
        let bare = fixture.directory("bare.git");
        assert!(fixture.git(&bare, &["init", "--bare"]).status.success());
        assert_eq!(
            fixture.initialize(&bare, "main").unwrap_err().to_string(),
            EXISTING_REPOSITORY
        );
        let linked = fixture.directory("linked");
        let marker = "gitdir: ../bare.git/worktrees/linked\n";
        fs::write(linked.join(".git"), marker).unwrap();
        let child = linked.join("child");
        fs::create_dir(&child).unwrap();
        for target in [&linked, &child] {
            assert_eq!(
                fixture.initialize(target, "main").unwrap_err().to_string(),
                EXISTING_REPOSITORY
            );
        }
        assert_eq!(fs::read_to_string(linked.join(".git")).unwrap(), marker);
    }

    #[test]
    fn reports_a_missing_selected_executable_without_creating_metadata() {
        let fixture = Fixture::new();
        let root = fixture.directory("missing executable");
        let missing = fixture.temporary.path().join("missing-git");
        let error = initialize_with(&root.to_string_lossy(), "main", |root| {
            initialization_command(&missing, root)
        })
        .unwrap_err();
        assert_eq!(error.to_string(), GIT_MISSING);
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn localizes_metadata_even_when_global_config_prefers_a_bare_worktree() {
        let fixture = Fixture::new();
        let root = fixture.directory("project");
        let other = fixture.directory("other");
        fs::write(other.join("HEAD"), "keep this file").unwrap();
        assert!(fixture
            .git(&root, &["config", "--global", "core.bare", "true"])
            .status
            .success());
        assert!(fixture
            .git(
                &root,
                &[
                    "config",
                    "--global",
                    "core.worktree",
                    &other.to_string_lossy()
                ]
            )
            .status
            .success());
        let config = fs::read(&fixture.global).unwrap();
        fixture.initialize(&root, "main").unwrap();
        assert!(root.join(".git/HEAD").is_file());
        assert!(!root.join("HEAD").exists());
        assert!(!other.join(".git").exists());
        let top = fixture.git(&root, &["rev-parse", "--show-toplevel"]);
        assert!(top.status.success());
        assert_eq!(
            fs::canonicalize(String::from_utf8(top.stdout).unwrap().trim()).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert_eq!(
            fs::read_to_string(other.join("HEAD")).unwrap(),
            "keep this file"
        );
        assert_eq!(fs::read(&fixture.global).unwrap(), config);
    }

    #[test]
    fn rejects_an_actual_linked_worktree_and_preserves_its_head() {
        let fixture = Fixture::new();
        let root = fixture.directory("main");
        fixture.initialize(&root, "main").unwrap();
        assert!(fixture
            .git(
                &root,
                &[
                    "-c",
                    "commit.gpgSign=false",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "base"
                ]
            )
            .status
            .success());
        let linked = fixture.temporary.path().join("linked-live");
        assert!(fixture
            .git(
                &root,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    "--",
                    &linked.to_string_lossy()
                ]
            )
            .status
            .success());
        let before = fixture.git(&linked, &["rev-parse", "HEAD"]).stdout;
        assert_eq!(
            fixture.initialize(&linked, "main").unwrap_err().to_string(),
            EXISTING_REPOSITORY
        );
        assert_eq!(fixture.git(&linked, &["rev-parse", "HEAD"]).stdout, before);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_into_existing_worktrees() {
        let fixture = Fixture::new();
        let root = fixture.directory("repository");
        fixture.initialize(&root, "main").unwrap();
        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        let link = fixture.temporary.path().join("alias");
        std::os::unix::fs::symlink(&child, &link).unwrap();
        assert_eq!(
            fixture.initialize(&link, "main").unwrap_err().to_string(),
            EXISTING_REPOSITORY
        );
        assert!(!child.join(".git").exists());
    }
}
