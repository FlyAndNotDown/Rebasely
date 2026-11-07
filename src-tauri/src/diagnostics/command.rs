use std::fmt::{self, Write};
use std::process::{ExitStatus, Output};
use std::sync::OnceLock;

use regex::Regex;

use super::event::Category;

const OUTPUT_BYTES: usize = 1024;

#[derive(Clone, Copy, Default)]
pub struct CommandOutput<'a> {
    pub status: Option<ExitStatus>,
    pub stdout: &'a [u8],
    pub stderr: &'a [u8],
}

impl<'a> From<&'a Output> for CommandOutput<'a> {
    fn from(output: &'a Output) -> Self {
        Self {
            status: Some(output.status),
            stdout: &output.stdout,
            stderr: &output.stderr,
        }
    }
}

#[derive(Debug)]
pub(super) struct CommandReport {
    pub invocation: String,
    status: Option<ExitStatus>,
    stdout: Option<String>,
    stderr: Option<String>,
}

impl CommandReport {
    pub(super) fn new(category: Category, args: &[&str], output: CommandOutput<'_>) -> Self {
        let (program, prefix, args) = match category {
            Category::Git => ("git", "", args),
            Category::P4 if args.first() == Some(&"-ztag") => ("p4", " -ztag", &args[1..]),
            Category::P4 => ("p4", "", args),
            _ => unreachable!("only VCS commands carry CLI output"),
        };
        let (verb, args) = args.split_first().unwrap_or((&"", &[]));
        // The adapters supply known verbs. Refuse arbitrary command names too.
        let verb = if verb.len() <= 32
            && !verb.is_empty()
            && verb
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        {
            *verb
        } else {
            "<command>"
        };
        let mut invocation = format!("{program}{prefix} {verb}");
        let args = match (
            verb,
            args.split_first().map(|(&action, rest)| (action, rest)),
        ) {
            (
                "remote" | "worktree",
                Some((action @ ("add" | "remove" | "set-url" | "prune"), rest)),
            ) => {
                write!(invocation, " {action}").expect("writing to a string");
                rest
            }
            _ => args,
        };
        let mut omitted = false;
        for arg in args.iter().take(32).take_while(|arg| **arg != "--") {
            if matches!(
                *arg,
                "--abort"
                    | "--all"
                    | "--amend"
                    | "--atomic"
                    | "--cached"
                    | "--check"
                    | "--continue"
                    | "--exit-code"
                    | "--ff-only"
                    | "--force"
                    | "--force-with-lease"
                    | "--hard"
                    | "--no-edit"
                    | "--no-index"
                    | "--no-tags"
                    | "--pathspec-file-nul"
                    | "--pathspec-from-file=-"
                    | "--porcelain"
                    | "--progress"
                    | "--prune"
                    | "--quiet"
                    | "--rebase"
                    | "--soft"
                    | "--tags"
                    | "-am"
                    | "-as"
                    | "-at"
                    | "-ay"
                    | "-d"
                    | "-f"
                    | "-i"
                    | "-n"
                    | "-N"
                    | "-q"
                    | "-s"
            ) {
                write!(invocation, " {arg}").expect("writing to a string");
            } else {
                omitted = true;
            }
        }
        if omitted || args.len() > 32 || args.contains(&"--") {
            invocation.push_str(" <args omitted>");
        }

        // Some commands expose secret configuration or return file content, history,
        // or descriptions. Keep their invocation and exit status without that data.
        let sensitive = matches!(
            verb,
            "login" | "logout" | "passwd" | "tickets" | "set" | "config"
        );
        let stdout_useful = match category {
            Category::Git => matches!(verb, "fetch" | "pull" | "push" | "clone"),
            Category::P4 => matches!(
                verb,
                "sync"
                    | "submit"
                    | "resolve"
                    | "shelve"
                    | "unshelve"
                    | "revert"
                    | "edit"
                    | "add"
                    | "delete"
                    | "reopen"
                    | "move"
                    | "reconcile"
                    | "integrate"
                    | "undo"
            ),
            _ => false,
        };

        Self {
            invocation,
            status: output.status,
            stdout: stdout_useful.then(|| excerpt(output.stdout)).flatten(),
            stderr: (!sensitive).then(|| excerpt(output.stderr)).flatten(),
        }
    }

    pub(super) fn write_exit(&self, line: &mut String) -> fmt::Result {
        if let Some(status) = self.status {
            if let Some(code) = status.code() {
                write!(line, " (exit {code})")?;
            } else {
                write!(line, " ({status})")?;
            }
        }
        Ok(())
    }

    pub(super) fn write_output(&self, time: &str, log: &mut String) -> fmt::Result {
        for (stream, output) in [("stderr", &self.stderr), ("stdout", &self.stdout)] {
            if let Some(output) = output {
                write_output_lines(log, time, stream, output)?;
            }
        }
        Ok(())
    }
}

pub(super) fn write_output_lines(
    log: &mut String,
    time: &str,
    stream: &str,
    output: &str,
) -> fmt::Result {
    for line in output.lines() {
        writeln!(log, "[{time}][VERBOSE][Commands] {stream}: {line}")?;
    }
    Ok(())
}

// Keep only complete lines from a bounded tail. Starting mid-line can leave
// part of a credential without the prefix the redactor needs to recognize it.
pub(super) fn excerpt(bytes: &[u8]) -> Option<String> {
    let inspected = bytes.len().saturating_sub(OUTPUT_BYTES * 2);
    let end = bytes[inspected..]
        .iter()
        .rposition(|byte| !matches!(byte, b'\n' | b'\r'))
        .map(|index| inspected + index + 1)?;
    let start = end.saturating_sub(OUTPUT_BYTES);
    let tail = &bytes[start..end];
    let tail = if start > 0 && !matches!(bytes[start - 1], b'\n' | b'\r') {
        match tail.iter().position(|byte| matches!(byte, b'\n' | b'\r')) {
            Some(index) => &tail[index + 1..],
            None => return Some("[output omitted: line exceeds 1024 bytes]".to_owned()),
        }
    } else {
        tail
    };
    let value = String::from_utf8_lossy(tail);
    if value.trim().is_empty() {
        return None;
    }
    if bytes[inspected..]
        .windows(b"PRIVATE KEY-----".len())
        .any(|part| part == b"PRIVATE KEY-----")
    {
        return Some("[private key output omitted]".to_owned());
    }
    let cleaned = redact(&value.replace("\r\n", "\n").replace('\r', "\n"));
    Some(if start > 0 {
        format!("[tail] {cleaned}")
    } else {
        cleaned
    })
}

pub(super) fn redact(value: &str) -> String {
    static ESCAPE: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    static AUTH: OnceLock<Regex> = OnceLock::new();
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    static KEY_MATERIAL: OnceLock<Regex> = OnceLock::new();

    if value.contains("PRIVATE KEY-----") {
        return "[private key output omitted]".to_owned();
    }
    let escape = ESCAPE.get_or_init(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("valid terminal escape pattern")
    });
    let cleaned: String = escape
        .replace_all(value, "")
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect();
    let cleaned = crate::error::redact_credentials(&cleaned);
    let url = URL.get_or_init(|| {
        Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*://[^\s"'<>()?#]+)(?:[?#][^\s"'<>()]*)?"#)
            .expect("valid URL pattern")
    });
    let cleaned = url.replace_all(&cleaned, |captures: &regex::Captures<'_>| {
        let address = &captures[1];
        let (scheme, rest) = address.split_once("://").expect("matched URL scheme");
        let authority_end = rest.find('/').unwrap_or(rest.len());
        let address = if let Some(index) = rest[..authority_end].rfind('@') {
            format!("{scheme}://[redacted]@{}", &rest[index + 1..])
        } else {
            address.to_owned()
        };
        if captures[0].len() > captures[1].len() {
            format!("{address}?[redacted]")
        } else {
            address
        }
    });
    let auth = AUTH.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:proxy-)?authorization["']?\s*[:=]\s*|bearer[ \t]+)[^\r\n]+"#)
            .expect("valid authorization pattern")
    });
    let cleaned = auth.replace_all(&cleaned, "${1}[redacted]");
    let assignment = ASSIGNMENT.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:p4passwd|password|passwd|passphrase|(?:access[_-]?|private[_-]?)?token|api[_-]?key|secret|cookie)\b["']?\s*[:=]\s*)[^\r\n]+"#)
            .expect("valid secret assignment pattern")
    });
    let cleaned = assignment.replace_all(&cleaned, "${1}[redacted]");
    let token = TOKEN.get_or_init(|| {
        Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b")
            .expect("valid token pattern")
    });
    let cleaned = token.replace_all(&cleaned, "[redacted]");
    let key_material = KEY_MATERIAL.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*[A-Za-z0-9+/]{48,}={0,2}[ \t]*\r?$")
            .expect("valid key material pattern")
    });
    key_material
        .replace_all(&cleaned, "[redacted]")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_reports_keep_useful_output_and_hide_credential_material() {
        let report = CommandReport::new(
            Category::Git,
            &["fetch", "--progress", "--", "https://user:arg-secret@example.test/"],
            CommandOutput {
                status: None,
                stderr: b"fatal: unable to access 'https://user:url-secret@example.test/repo?unknown=query-secret': 403\n\
                    Authorization: Basic header-secret\nP4PASSWD=env-secret\n\
                    \x1b[31merror:\x1b[0m the remote rejected the request\n",
                stdout: b"remote response\n",
            },
        );
        assert_eq!(report.invocation, "git fetch --progress <args omitted>");
        let mut text = String::new();
        report
            .write_output("2026-01-01 12:00:00.000 +08:00", &mut text)
            .unwrap();
        assert!(text.contains("403"));
        assert!(text.contains("the remote rejected the request"));
        assert!(text.contains("remote response"));
        assert!(!text.contains("-secret"));
        assert!(!text.contains("[31m"));

        let sensitive = CommandOutput {
            stdout: b"secret config\n",
            stderr: b"secret ticket\n",
            status: None,
        };
        let login = CommandReport::new(Category::P4, &["login"], sensitive);
        assert!(login.stdout.is_none() && login.stderr.is_none());
        let diff = CommandReport::new(Category::Git, &["diff"], sensitive);
        assert!(diff.stdout.is_none());
    }

    #[test]
    fn excerpts_skip_partial_lines_and_preserve_the_final_error() {
        let mut output = vec![b'x'; OUTPUT_BYTES * 4];
        output.extend_from_slice(b"\nerror: repository is unavailable\n");
        assert_eq!(
            excerpt(&output).as_deref(),
            Some("[tail] error: repository is unavailable")
        );
    }
}
