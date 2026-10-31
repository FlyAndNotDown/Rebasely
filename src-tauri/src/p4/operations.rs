//! Previewed, single-file integration and submitted-change undo workflows.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::cli;
use super::parse::{parse_ztag, path_is_within, spec_field, valid_depot_path};
use super::workspace::{env_for, workspace_directory_path, workspace_file_spec, P4Connection};
use crate::error::{AppError, AppResult};
use crate::git::strip_verbatim_prefix;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4RevisionRange {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4IntegrateRequest {
    pub source: String,
    pub target: String,
    pub range: Option<P4RevisionRange>,
    pub change_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum P4UndoSelector {
    Revision { revision: String },
    Range { from: String, to: String },
    Changelist { change: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4UndoRequest {
    pub path: String,
    pub selector: P4UndoSelector,
    pub change_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4OperationPreview {
    pub output: String,
    pub fingerprint: String,
    pub target: String,
}

struct OperationPlan {
    args: Vec<String>,
    target: PathBuf,
    // Includes the source revision and server's source/target mapping. A fresh
    // preview must still describe the same inputs when Apply is clicked.
    facts: Vec<String>,
}

#[derive(Eq, PartialEq, Hash)]
struct TargetState {
    length: u64,
    modified: SystemTime,
    readonly: bool,
    content: u64,
}

const PREVIEW_CHANGED: &str =
    "The operation or workspace changed. Preview it again before applying.";

pub fn preview_integrate(
    connection: &P4Connection,
    request: &P4IntegrateRequest,
) -> AppResult<P4OperationPreview> {
    let mut run = |args: &[String]| run_cli(connection, args);
    let plan = integrate_plan(connection, request, &mut run)?;
    preview_plan(connection, &plan, &mut run)
}

pub fn apply_integrate(
    connection: &P4Connection,
    request: &P4IntegrateRequest,
    fingerprint: &str,
) -> AppResult<String> {
    let mut run = |args: &[String]| run_cli(connection, args);
    let plan = integrate_plan(connection, request, &mut run)?;
    apply_plan(connection, &plan, fingerprint, &mut run)
}

pub fn preview_undo(
    connection: &P4Connection,
    request: &P4UndoRequest,
) -> AppResult<P4OperationPreview> {
    let mut run = |args: &[String]| run_cli(connection, args);
    let plan = undo_plan(connection, request, &mut run)?;
    preview_plan(connection, &plan, &mut run)
}

pub fn apply_undo(
    connection: &P4Connection,
    request: &P4UndoRequest,
    fingerprint: &str,
) -> AppResult<String> {
    let mut run = |args: &[String]| run_cli(connection, args);
    let plan = undo_plan(connection, request, &mut run)?;
    apply_plan(connection, &plan, fingerprint, &mut run)
}

fn run_cli(connection: &P4Connection, args: &[String]) -> AppResult<String> {
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    cli::run_p4_ok(&env_for(connection), &args, None)
}

fn positive_number(value: &str) -> AppResult<u64> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::msg(
            "Enter a positive revision or changelist number.",
        ));
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| AppError::msg("Enter a positive revision or changelist number."))
}

fn revision_range(from: &str, to: &str) -> AppResult<String> {
    let from = positive_number(from)?;
    let to = positive_number(to)?;
    if from > to {
        return Err(AppError::msg(
            "The first revision must not exceed the last revision.",
        ));
    }
    Ok(format!("#{from},#{to}"))
}

fn pending_change(
    connection: &P4Connection,
    id: &str,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<String> {
    if id.trim() == "default" {
        return Ok("default".into());
    }
    let id = positive_number(id)?.to_string();
    let spec = run(&["change".into(), "-o".into(), id.clone()])?;
    if spec_field(&spec, "Status") != "pending"
        || spec_field(&spec, "User") != connection.user
        || spec_field(&spec, "Client") != connection.client
    {
        return Err(AppError::msg(
            "Choose your own pending changelist in this workspace.",
        ));
    }
    Ok(id)
}

fn source_file(source: &str) -> AppResult<()> {
    // Depot paths returned by P4 already encode #, @, %, and literal *.
    // Revisions belong to the typed selector instead of the path itself.
    if !source.starts_with("//")
        || !valid_depot_path(source)
        || source.contains("...")
        || source.contains("%%")
        || source
            .split('/')
            .skip(2)
            .any(|part| part.is_empty() || part == "." || part == "..")
        || source.split('/').count() < 4
    {
        return Err(AppError::msg(
            "Choose one depot file without wildcards or revision suffixes.",
        ));
    }
    Ok(())
}

fn workspace_target(connection: &P4Connection, value: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(strip_verbatim_prefix(value));
    if !path.is_absolute() || value.chars().any(char::is_control) || value.contains("...") {
        return Err(AppError::msg("Choose one absolute local workspace file."));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::msg("Choose a workspace file."))?;
    let parent = workspace_directory_path(Path::new(&connection.root), parent.to_path_buf())?;
    let path = fs::canonicalize(parent)?.join(
        path.file_name()
            .ok_or_else(|| AppError::msg("Choose a workspace file."))?,
    );
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(AppError::msg(
            "Choose a regular workspace file, not a folder or symbolic link.",
        )),
        Ok(_) => Ok(PathBuf::from(strip_verbatim_prefix(
            &fs::canonicalize(path)?.to_string_lossy(),
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PathBuf::from(
            strip_verbatim_prefix(&path.to_string_lossy()),
        )),
        Err(error) => Err(error.into()),
    }
}

fn mapped_target(
    connection: &P4Connection,
    target: &Path,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<String> {
    let spec = workspace_file_spec(&connection.root, &target.to_string_lossy());
    let output = run(&["-ztag".into(), "where".into(), spec])?;
    let mappings: Vec<_> = parse_ztag(&output)
        .into_iter()
        .filter(|record| !record.contains_key("unmap"))
        .collect();
    if mappings.len() != 1 {
        return Err(AppError::msg(
            "Choose a file mapped once by this workspace view.",
        ));
    }
    let record = &mappings[0];
    let depot = record
        .get("depotFile")
        .map(String::as_str)
        .unwrap_or_default();
    source_file(depot)?;
    let local = record.get("path").map(String::as_str).unwrap_or_default();
    let mapped = workspace_target(connection, local)?;
    if !path_is_within(target, &mapped) || !path_is_within(&mapped, target) {
        return Err(AppError::msg(
            "The file mapping does not match the selected workspace file.",
        ));
    }
    Ok(output)
}

fn integrate_plan(
    connection: &P4Connection,
    request: &P4IntegrateRequest,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<OperationPlan> {
    source_file(&request.source)?;
    let target = workspace_target(connection, &request.target)?;
    let range = request
        .range
        .as_ref()
        .map(|range| revision_range(&range.from, &range.to))
        .transpose()?
        .unwrap_or_default();
    let change = pending_change(connection, &request.change_id, run)?;
    let mapping = mapped_target(connection, &target, run)?;
    let target_facts = target_facts(connection, &target, &mapping, run)?;
    let source = run(&["-ztag".into(), "files".into(), request.source.clone()])?;
    let records = parse_ztag(&source);
    if records.len() != 1 || records[0].get("depotFile") != Some(&request.source) {
        return Err(AppError::msg(
            "Choose the exact depot file path returned by Perforce.",
        ));
    }
    let source_spec = format!("{}{range}", request.source);
    let target_spec = workspace_file_spec(&connection.root, &target.to_string_lossy());
    Ok(OperationPlan {
        args: vec![
            "integrate".into(),
            "-c".into(),
            change,
            source_spec,
            target_spec,
        ],
        target,
        facts: vec![mapping, source, target_facts],
    })
}

fn undo_plan(
    connection: &P4Connection,
    request: &P4UndoRequest,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<OperationPlan> {
    let target = workspace_target(connection, &request.path)?;
    let suffix = match &request.selector {
        P4UndoSelector::Revision { revision } => format!("#{}", positive_number(revision)?),
        P4UndoSelector::Range { from, to } => revision_range(from, to)?,
        // An equal endpoint range selects only revisions submitted in that
        // change, instead of silently selecting an earlier file revision.
        P4UndoSelector::Changelist { change } => {
            let change = positive_number(change)?;
            format!("@{change},@{change}")
        }
    };
    let change = pending_change(connection, &request.change_id, run)?;
    let mapping = mapped_target(connection, &target, run)?;
    let target_facts = target_facts(connection, &target, &mapping, run)?;
    let spec = workspace_file_spec(&connection.root, &target.to_string_lossy());
    Ok(OperationPlan {
        args: vec![
            "undo".into(),
            "-c".into(),
            change,
            format!("{spec}{suffix}"),
        ],
        target,
        facts: vec![mapping, target_facts],
    })
}

fn target_state(path: &Path) -> AppResult<Option<TargetState>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some(TargetState {
            length: metadata.len(),
            modified: metadata.modified()?,
            readonly: metadata.permissions().readonly(),
            content: file_fingerprint(path)?,
        })),
        Ok(_) => Err(AppError::msg("Choose a regular workspace file.")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn file_fingerprint(path: &Path) -> AppResult<u64> {
    let mut file = fs::File::open(path)?;
    let mut hasher = DefaultHasher::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hasher.finish());
        }
        hasher.write(&buffer[..read]);
    }
}

fn target_facts(
    connection: &P4Connection,
    target: &Path,
    mapping: &str,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<String> {
    let spec = workspace_file_spec(&connection.root, &target.to_string_lossy());
    match run(&[
        "-ztag".into(),
        "fstat".into(),
        "-T".into(),
        "depotFile clientFile haveRev headRev headChange headAction headType action change".into(),
        spec,
    ]) {
        Ok(output) => {
            let records = parse_ztag(&output);
            if records.is_empty() && !target.exists() {
                return Ok(output);
            }
            let mappings = parse_ztag(mapping);
            let expected = mappings
                .iter()
                .filter(|record| !record.contains_key("unmap"))
                .find_map(|record| record.get("depotFile"));
            if records.len() != 1 || expected.is_none() || records[0].get("depotFile") != expected {
                return Err(AppError::msg(
                    "Choose an absent target or one versioned workspace file.",
                ));
            }
            Ok(output)
        }
        // A new branch target may not exist in the depot yet. Authentication,
        // transport, and unmapped-path failures must still reach the caller.
        Err(error) if !target.exists() && missing_depot_file(&error.to_string()) => {
            Ok(String::new())
        }
        Err(error) => Err(error),
    }
}

fn missing_depot_file(message: &str) -> bool {
    let records = parse_ztag(message);
    if !records.is_empty() {
        return records.iter().all(|record| {
            record.get("code").map(String::as_str) == Some("error")
                && record
                    .get("data")
                    .is_some_and(|data| data.trim_end().ends_with(" - no such file(s)."))
        });
    }
    let lines: Vec<_> = message
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    !lines.is_empty()
        && lines
            .iter()
            .all(|line| line.trim_end().ends_with(" - no such file(s)."))
}

fn preview_plan(
    connection: &P4Connection,
    plan: &OperationPlan,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<P4OperationPreview> {
    let state = target_state(&plan.target)?;
    let mut args = plan.args.clone();
    args.insert(1, "-n".into());
    let output = run(&args)?;
    if target_state(&plan.target)? != state {
        return Err(AppError::msg(PREVIEW_CHANGED));
    }
    // This is a consistency receipt, not an authorization token. Apply runs a
    // fresh CLI preview too; the UI separately requires reviewing unchanged inputs.
    let mut hasher = DefaultHasher::new();
    connection.root.hash(&mut hasher);
    connection.port.hash(&mut hasher);
    connection.user.hash(&mut hasher);
    connection.client.hash(&mut hasher);
    connection.charset.hash(&mut hasher);
    plan.args.hash(&mut hasher);
    plan.facts.hash(&mut hasher);
    state.hash(&mut hasher);
    output.hash(&mut hasher);
    Ok(P4OperationPreview {
        output,
        fingerprint: format!("{:016x}", hasher.finish()),
        target: plan.target.to_string_lossy().into_owned(),
    })
}

fn apply_plan(
    connection: &P4Connection,
    plan: &OperationPlan,
    fingerprint: &str,
    run: &mut impl FnMut(&[String]) -> AppResult<String>,
) -> AppResult<String> {
    if fingerprint.is_empty() || preview_plan(connection, plan, run)?.fingerprint != fingerprint {
        return Err(AppError::msg(PREVIEW_CHANGED));
    }
    // P4 owns its normal clobber checks and resolve scheduling. Never add -f,
    // auto-resolve, or submit; the resulting pending files stay reviewable.
    run(&plan.args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(root: &Path) -> P4Connection {
        P4Connection {
            root: strip_verbatim_prefix(&root.to_string_lossy()),
            port: "perforce.example.com:1666".into(),
            user: "alice".into(),
            client: "dev-pc".into(),
            charset: String::new(),
            stream: None,
            server: String::new(),
        }
    }

    fn mapping(target: &Path) -> String {
        format!("... depotFile //depot/main/target%23%40%25.txt\n... clientFile //dev-pc/target%23%40%25.txt\n... path {}\n", target.display())
    }

    fn integration(target: &Path) -> P4IntegrateRequest {
        P4IntegrateRequest {
            source: "//depot/dev/source%23%40%25.txt".into(),
            target: target.to_string_lossy().into_owned(),
            range: Some(P4RevisionRange {
                from: "1".into(),
                to: "3".into(),
            }),
            change_id: "42".into(),
        }
    }

    fn preflight(args: &[String], target: &Path) -> AppResult<String> {
        match args
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["change", "-o", "42"] => {
                Ok("Change: 42\nStatus: pending\nUser: alice\nClient: dev-pc\n".into())
            }
            ["-ztag", "where", _] => Ok(mapping(target)),
            ["-ztag", "fstat", "-T", _, _] => Ok(
                "... depotFile //depot/main/target%23%40%25.txt\n... haveRev 1\n... headRev 1\n"
                    .into(),
            ),
            ["-ztag", "files", source] => Ok(format!(
                "... depotFile {source}\n... rev 3\n... action edit\n"
            )),
            _ => Err(AppError::msg("Unexpected test command")),
        }
    }

    #[test]
    fn integrate_previews_and_applies_the_same_explicit_pair_without_force_or_submit() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = connection(temporary.path());
        let target = temporary.path().join("target #@%.txt");
        fs::write(&target, b"local content\n").unwrap();
        let request = integration(&target);
        let mut commands = Vec::new();
        let mut run = |args: &[String]| {
            commands.push(args.to_vec());
            if args[0] == "integrate" {
                Ok(if args[1] == "-n" {
                    "would integrate\n"
                } else {
                    "opened for integrate\n"
                }
                .into())
            } else {
                preflight(args, &target)
            }
        };
        let plan = integrate_plan(&connection, &request, &mut run).unwrap();
        let preview = preview_plan(&connection, &plan, &mut run).unwrap();
        assert_eq!(preview.output, "would integrate\n");
        assert_eq!(
            PathBuf::from(&preview.target),
            workspace_target(&connection, &request.target).unwrap()
        );
        assert_eq!(fs::read(&target).unwrap(), b"local content\n");
        assert_eq!(
            apply_plan(&connection, &plan, &preview.fingerprint, &mut run).unwrap(),
            "opened for integrate\n"
        );
        let apply = commands.last().unwrap();
        assert_eq!(
            &apply[..4],
            &[
                "integrate",
                "-c",
                "42",
                "//depot/dev/source%23%40%25.txt#1,#3"
            ]
        );
        assert!(apply[4].ends_with("target %23%40%25.txt"));
        assert_eq!(
            commands
                .iter()
                .filter(|args| args[0] == "integrate" && args[1] == "-n")
                .count(),
            2
        );
        assert!(!commands
            .iter()
            .flatten()
            .any(|arg| matches!(arg.as_str(), "-f" | "submit" | "resolve" | "-S" | "-b")));
    }

    #[test]
    fn undo_selectors_are_typed_and_apply_only_the_selected_file() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = connection(temporary.path());
        // A missing file is valid: undoing a submitted deletion can restore it.
        let target = temporary.path().join("target #@%.txt");
        for (selector, suffix) in [
            (
                P4UndoSelector::Revision {
                    revision: "2".into(),
                },
                "#2",
            ),
            (
                P4UndoSelector::Range {
                    from: "2".into(),
                    to: "4".into(),
                },
                "#2,#4",
            ),
            (
                P4UndoSelector::Changelist {
                    change: "42".into(),
                },
                "@42,@42",
            ),
        ] {
            let request = P4UndoRequest {
                path: target.to_string_lossy().into_owned(),
                selector,
                change_id: "default".into(),
            };
            let mut run = |args: &[String]| preflight(args, &target);
            let plan = undo_plan(&connection, &request, &mut run).unwrap();
            assert_eq!(&plan.args[..3], &["undo", "-c", "default"]);
            assert_eq!(plan.args.len(), 4);
            assert!(plan.args[3].ends_with(&format!("target %23%40%25.txt{suffix}")));
        }
        for invalid in ["", "0", "-1", "42 -f", "42,@99", "999999999999999999999"] {
            assert!(positive_number(invalid).is_err());
        }
        assert!(revision_range("4", "2").is_err());
    }

    #[test]
    fn apply_refuses_changed_inputs_output_mapping_or_workspace_file() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = connection(temporary.path());
        let target = temporary.path().join("target.txt");
        fs::write(&target, b"before\n").unwrap();
        let request = integration(&target);
        let mut run = |args: &[String]| {
            if args[0] == "integrate" {
                assert_eq!(args[1], "-n");
                Ok("preview\n".into())
            } else {
                preflight(args, &target)
            }
        };
        let plan = integrate_plan(&connection, &request, &mut run).unwrap();
        let preview = preview_plan(&connection, &plan, &mut run).unwrap();
        assert!(apply_plan(&connection, &plan, "", &mut run).is_err());
        let mut changed_plan = OperationPlan {
            args: plan.args.clone(),
            target: plan.target.clone(),
            facts: plan.facts.clone(),
        };
        changed_plan.args[2] = "43".into();
        assert!(apply_plan(&connection, &changed_plan, &preview.fingerprint, &mut run).is_err());
        changed_plan.args.clone_from(&plan.args);
        changed_plan.facts.push("mapping changed".into());
        assert!(apply_plan(&connection, &changed_plan, &preview.fingerprint, &mut run).is_err());
        let mut different_output = |args: &[String]| {
            assert_eq!(args[1], "-n");
            Ok("different preview\n".into())
        };
        assert!(apply_plan(
            &connection,
            &plan,
            &preview.fingerprint,
            &mut different_output
        )
        .is_err());
        fs::write(&target, b"new local work\n").unwrap();
        assert!(apply_plan(&connection, &plan, &preview.fingerprint, &mut run).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"new local work\n");
    }

    #[test]
    fn plans_reject_broad_paths_and_nonowned_changes_before_preview() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = connection(temporary.path());
        let target = temporary.path().join("target.txt");
        for source in [
            "",
            "//depot/...",
            "//depot/main/*",
            "//depot/file#2",
            "//depot/file@42",
            "//depot/../file",
            "//depot//file",
            "relative.txt",
            "-f",
        ] {
            let mut request = integration(&target);
            request.source = source.into();
            assert!(integrate_plan(&connection, &request, &mut |_| panic!(
                "invalid source reached CLI"
            ))
            .is_err());
        }
        for path in [
            temporary.path().to_path_buf(),
            temporary.path().join("missing/target.txt"),
            temporary.path().join("../outside.txt"),
            PathBuf::from("relative.txt"),
        ] {
            assert!(workspace_target(&connection, &path.to_string_lossy()).is_err());
        }
        for spec in [
            "Status: submitted\nUser: alice\nClient: dev-pc\n",
            "Status: pending\nUser: bob\nClient: dev-pc\n",
            "Status: pending\nUser: alice\nClient: other-pc\n",
        ] {
            assert!(pending_change(&connection, "42", &mut |_| Ok(spec.into())).is_err());
        }
        let mut bad_mapping =
            |_: &[String]| Ok("... depotFile //depot/main/file.txt\n... unmap\n".into());
        assert!(mapped_target(&connection, &target, &mut bad_mapping).is_err());
    }

    #[test]
    fn preview_preserves_full_command_output_and_rejects_target_edits_during_preview() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = connection(temporary.path());
        let target = temporary.path().join("target.txt");
        fs::write(&target, b"before\n").unwrap();
        let plan = OperationPlan {
            args: vec![
                "undo".into(),
                "-c".into(),
                "default".into(),
                target.to_string_lossy().into_owned(),
            ],
            target: target.clone(),
            facts: vec![],
        };
        let output = "one legitimate output line\n".repeat(10_000);
        let preview = preview_plan(&connection, &plan, &mut |_| Ok(output.clone())).unwrap();
        assert_eq!(preview.output, output);
        assert!(preview_plan(&connection, &plan, &mut |_| {
            fs::write(&target, b"new local content\n").unwrap();
            Ok("preview\n".into())
        })
        .is_err());
    }

    #[test]
    fn receipts_detect_same_length_edits_even_when_modification_time_is_restored() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("target.txt");
        fs::write(&path, b"before\n").unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let before = target_state(&path).unwrap();
        fs::write(&path, b"edited\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let after = target_state(&path).unwrap();
        assert_eq!(
            before.as_ref().unwrap().length,
            after.as_ref().unwrap().length
        );
        assert_eq!(
            before.as_ref().unwrap().modified,
            after.as_ref().unwrap().modified
        );
        assert!(before != after);
    }

    #[test]
    fn only_an_unversioned_absent_target_may_ignore_a_missing_fstat() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = connection(temporary.path());
        let target = temporary.path().join("new.txt");
        assert!(
            target_facts(&connection, &target, &mapping(&target), &mut |_| Err(
                AppError::msg("//depot/new.txt - no such file(s).")
            ))
            .unwrap()
            .is_empty()
        );
        for message in [
            "Perforce login is required.",
            "Connection failed.",
            "File is not in client view.",
        ] {
            assert!(
                target_facts(&connection, &target, &mapping(&target), &mut |_| Err(
                    AppError::msg(message)
                ))
                .is_err()
            );
        }
        fs::write(&target, b"local work\n").unwrap();
        assert!(
            target_facts(&connection, &target, &mapping(&target), &mut |_| Err(
                AppError::msg("//depot/new.txt - no such file(s).")
            ))
            .is_err()
        );
        assert!(missing_depot_file("... code error\n... severity 3\n... generic 17\n... data //depot/new.txt - no such file(s).\n"));
        // P4 can report missing fstat metadata on stderr with a successful
        // exit code, so the adapter returns an empty successful stdout.
        assert!(
            target_facts(&connection, &target, &mapping(&target), &mut |_| Ok(
                String::new()
            ))
            .is_err()
        );
        assert!(
            target_facts(&connection, &target, &mapping(&target), &mut |_| Ok(
                "... depotFile //depot/other.txt\n... headRev 1\n".into()
            ))
            .is_err()
        );
        fs::remove_file(&target).unwrap();
        assert!(
            target_facts(&connection, &target, &mapping(&target), &mut |_| Ok(
                String::new()
            ))
            .unwrap()
            .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn target_validation_preserves_spaces_and_rejects_symlink_escapes() {
        let temporary = tempfile::tempdir().unwrap();
        let workspace = temporary.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let connection = connection(&workspace);
        let target = workspace.join(" target.txt ");
        fs::write(&target, b"keep\n").unwrap();
        assert_eq!(
            workspace_target(&connection, &target.to_string_lossy()).unwrap(),
            target
        );
        let outside = temporary.path().join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("linked")).unwrap();
        assert!(workspace_target(
            &connection,
            &workspace.join("linked/file.txt").to_string_lossy()
        )
        .is_err());
        std::os::unix::fs::symlink(&target, workspace.join("symlink.txt")).unwrap();
        assert!(workspace_target(
            &connection,
            &workspace.join("symlink.txt").to_string_lossy()
        )
        .is_err());
    }
}
