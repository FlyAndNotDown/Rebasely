use serde::Serialize;
use std::io;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Git(#[from] git2::Error),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Message(String),
}

/// The frontend matches this exact text to tell a cancel from a failure.
pub const CANCELLED: &str = "Cancelled";

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
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
