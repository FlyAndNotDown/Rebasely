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

fn tree_blob(repo: &Repository, tree: Option<&git2::Tree<'_>>, path: &str) -> Option<Vec<u8>> {
    let entry = tree?.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
    Some(blob.content().to_vec())
}

fn index_blob(repo: &Repository, path: &str) -> Option<Vec<u8>> {
    let mut index = repo.index().ok()?;
    index.read(false).ok()?;
    let entry = index.get_path(Path::new(path), 0)?;
    Some(repo.find_blob(entry.id).ok()?.content().to_vec())
}

fn head_tree(repo: &Repository) -> Option<git2::Tree<'_>> {
    repo.head().ok()?.peel_to_tree().ok()
}

pub fn image_pair(repo: &Repository, source: &FileSource) -> AppResult<ImagePair> {
    let side = |path: &str, bytes: Option<Vec<u8>>| bytes.map(|bytes| image_side(path, &bytes));
    let (before, after) = match source {
        FileSource::Workdir { path, staged } => {
            let rel = safe_repo_path(path)?;
            if *staged {
                let head = head_tree(repo);
                (
                    side(&rel, tree_blob(repo, head.as_ref(), &rel)),
                    side(&rel, index_blob(repo, &rel)),
                )
            } else {
                let full = ensure_inside_workdir(repo, &rel)?;
                let current = if full.is_file() {
                    Some(fs::read(&full)?)
                } else {
                    None
                };
                (side(&rel, index_blob(repo, &rel)), side(&rel, current))
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
            let tree = commit.tree()?;
            let parent = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
            (
                side(&old, tree_blob(repo, parent.as_ref(), &old)),
                side(&rel, tree_blob(repo, Some(&tree), &rel)),
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
            let base_tree = peel_commit(repo, base)?.tree()?;
            let head_tree = peel_commit(repo, head)?.tree()?;
            (
                side(&old, tree_blob(repo, Some(&base_tree), &old)),
                side(&rel, tree_blob(repo, Some(&head_tree), &rel)),
            )
        }
        FileSource::Stash { oid, path } => {
            let rel = safe_repo_path(path)?;
            let stash = peel_commit(repo, oid)?;
            let base = stash.parent(0).ok().and_then(|parent| parent.tree().ok());
            let tree = stash.tree()?;
            // Untracked files live in the stash's third parent.
            let untracked = stash.parent(2).ok().and_then(|parent| parent.tree().ok());
            let current = tree_blob(repo, Some(&tree), &rel)
                .or_else(|| tree_blob(repo, untracked.as_ref(), &rel));
            (
                side(&rel, tree_blob(repo, base.as_ref(), &rel)),
                side(&rel, current),
            )
        }
    };
    Ok(ImagePair { before, after })
}
