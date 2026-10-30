use super::*;

use base64::Engine;

/// Larger images are described but not sent to the webview.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const LFS_POINTER: &[u8] = b"version https://git-lfs.github.com/spec/";

/// Where the two sides of a file diff come from, for image diffs and external
/// diff tools; mirrors the text diffs.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileSource {
    /// Index to working tree, or HEAD to index when `staged`.
    Workdir { path: String, staged: bool },
    /// A commit against its first parent.
    Commit {
        oid: String,
        path: String,
        old_path: Option<String>,
    },
    Compare {
        base: String,
        head: String,
        path: String,
        old_path: Option<String>,
    },
    /// A stash against the commit it was made on.
    Stash { oid: String, path: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSide {
    pub data_url: Option<String>,
    pub size: u64,
    /// The stored content is a Git LFS pointer, not the image.
    pub lfs: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePair {
    pub before: Option<ImageSide>,
    pub after: Option<ImageSide>,
}

fn mime_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub(super) fn image_side(path: &str, bytes: &[u8]) -> ImageSide {
    let size = bytes.len() as u64;
    if bytes.starts_with(LFS_POINTER) {
        return ImageSide {
            data_url: None,
            size,
            lfs: true,
            too_large: false,
        };
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return ImageSide {
            data_url: None,
            size,
            lfs: false,
            too_large: true,
        };
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    ImageSide {
        data_url: Some(format!("data:{};base64,{encoded}", mime_for(path))),
        size,
        lfs: false,
        too_large: false,
    }
}

fn oversized_image(size: u64) -> ImageSide {
    ImageSide {
        data_url: None,
        size,
        lfs: false,
        too_large: true,
    }
}

fn blob_at(repo: &Repository, path: &str, spec: &str) -> Option<ImageSide> {
    let size = run_git_stdout(repo.workdir(), &["cat-file", "-s", spec]).ok()?;
    let size: u64 = String::from_utf8_lossy(&size).trim().parse().ok()?;
    if size > MAX_IMAGE_BYTES as u64 {
        return Some(oversized_image(size));
    }
    let mut child = spawn_git_stdout(repo.workdir(), &["cat-file", "blob", spec]).ok()?;
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return None;
    };
    let mut bytes = Vec::new();
    if stdout
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        stop_child(&mut child);
        return None;
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        stop_child(&mut child);
        return Some(oversized_image(size.max(bytes.len() as u64)));
    }
    child
        .wait()
        .ok()
        .filter(|status| status.success())
        .map(|_| image_side(path, &bytes))
}

fn worktree_side(path: &str, full: &Path) -> AppResult<Option<ImageSide>> {
    let metadata = match fs::metadata(full) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Ok(Some(oversized_image(metadata.len())));
    }
    let mut bytes = Vec::new();
    fs::File::open(full)?
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(Some(image_side(path, &bytes)))
}

pub fn image_pair(repo: &Repository, source: &FileSource) -> AppResult<ImagePair> {
    let (before, after) = match source {
        FileSource::Workdir { path, staged } => {
            let rel = safe_repo_path(path)?;
            if *staged {
                (
                    blob_at(repo, &rel, &format!("HEAD:{rel}")),
                    blob_at(repo, &rel, &format!(":0:{rel}")),
                )
            } else {
                let full = ensure_inside_workdir(repo, &rel)?;
                (
                    blob_at(repo, &rel, &format!(":0:{rel}")),
                    worktree_side(&rel, &full)?,
                )
            }
        }
        FileSource::Commit {
            oid,
            path,
            old_path,
        } => {
            let rel = safe_repo_path(path)?;
            let old = safe_repo_path(old_path.as_deref().unwrap_or(path))?;
            let commit = peel_commit(repo, oid)?;
            let parent = commit.parents.first();
            (
                parent.and_then(|parent| blob_at(repo, &old, &format!("{parent}:{old}"))),
                blob_at(repo, &rel, &format!("{}:{rel}", commit.id)),
            )
        }
        FileSource::Compare {
            base,
            head,
            path,
            old_path,
        } => {
            let rel = safe_repo_path(path)?;
            let old = safe_repo_path(old_path.as_deref().unwrap_or(path))?;
            let base = peel_commit(repo, base)?.id().to_string();
            let head = peel_commit(repo, head)?.id().to_string();
            (
                blob_at(repo, &old, &format!("{base}:{old}")),
                blob_at(repo, &rel, &format!("{head}:{rel}")),
            )
        }
        FileSource::Stash { oid, path } => {
            let rel = safe_repo_path(path)?;
            let stash = peel_commit(repo, oid)?;
            let current = blob_at(repo, &rel, &format!("{}:{rel}", stash.id)).or_else(|| {
                stash
                    .parents
                    .get(2)
                    .and_then(|parent| blob_at(repo, &rel, &format!("{parent}:{rel}")))
            });
            (
                stash
                    .parents
                    .first()
                    .and_then(|parent| blob_at(repo, &rel, &format!("{parent}:{rel}"))),
                current,
            )
        }
    };
    Ok(ImagePair { before, after })
}
