use serde::Serialize;
use std::io;
use std::sync::OnceLock;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Message(String),
}

/// The frontend matches this exact text to tell a cancel from a failure.
pub const CANCELLED: &str = "Cancelled";

/// The frontend matches this exact text to open Settings.
pub const GIT_MISSING: &str = "Git executable was not found. Choose one in Settings.";

/// The frontend matches this exact text to open Settings.
pub const P4_MISSING: &str = "p4 executable was not found. Choose one in Settings.";

/// The frontend matches this exact text and asks for a Perforce password.
pub const P4_LOGIN: &str = "Perforce login is required.";

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn cancelled() -> Self {
        Self::Message(CANCELLED.to_string())
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Message(message) if message == CANCELLED)
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&redact_credentials(&self.to_string()))
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub(crate) fn redact_credentials(message: &str) -> String {
    static USERINFO: OnceLock<regex::Regex> = OnceLock::new();
    static URLS: OnceLock<regex::Regex> = OnceLock::new();
    let userinfo = USERINFO.get_or_init(|| {
        regex::Regex::new(r"(?i)\b((?:https?|ssh|git)://)[^/\s?#]*@")
            .expect("valid credential pattern")
    });
    let sanitized = userinfo.replace_all(message, "${1}REDACTED@");
    let urls = URLS.get_or_init(|| {
        regex::Regex::new(r#"(?i)\b(?:https?|ssh|git)://[^\s\"'<>]+"#).expect("valid URL pattern")
    });
    urls.replace_all(&sanitized, |captures: &regex::Captures<'_>| {
        let value = &captures[0];
        let address = value.trim_end_matches([')', ']', '}', ',', ';']);
        let Ok(mut parsed) = url::Url::parse(address) else {
            return value.to_string();
        };
        let mut changed = false;
        let pairs: Vec<_> = parsed
            .query_pairs()
            .map(|(key, value)| {
                if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "access_token"
                        | "auth"
                        | "authorization"
                        | "password"
                        | "passwd"
                        | "secret"
                        | "token"
                        | "api_key"
                        | "apikey"
                        | "private_token"
                ) {
                    changed = true;
                    (key.into_owned(), "REDACTED".to_string())
                } else {
                    (key.into_owned(), value.into_owned())
                }
            })
            .collect();
        if !changed {
            return value.to_string();
        }
        parsed.query_pairs_mut().clear().extend_pairs(pairs);
        format!("{}{}", parsed.as_str(), &value[address.len()..])
    })
    .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_errors_remove_url_credentials_and_secret_query_values() {
        let error = AppError::msg("Failed to access 'https://alice:example-secret@example.com/repo.git?private_token=example-token&ref=main'");
        let serialized = serde_json::to_value(error).unwrap();
        let message = serialized.as_str().unwrap();
        assert!(!message.contains("alice"));
        assert!(!message.contains("example-secret"));
        assert!(!message.contains("example-token"));
        assert!(message.contains("REDACTED@example.com"));
        assert!(message.contains("private_token=REDACTED&ref=main"));
    }

    #[test]
    fn malformed_remote_urls_still_do_not_expose_userinfo() {
        assert_eq!(
            redact_credentials("https://alice:example-secret@not a URL"),
            "https://REDACTED@not a URL"
        );
        assert_eq!(redact_credentials(GIT_MISSING), GIT_MISSING);
        assert_eq!(redact_credentials(P4_LOGIN), P4_LOGIN);
    }
}
