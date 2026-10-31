use super::*;

use base64::Engine;
use std::cell::OnceCell;
use std::process::ExitStatus;
use std::time::Instant;

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

struct LfsPointer<'a> {
    oid: &'a str,
    size: u64,
}

fn lfs_pointer(bytes: &[u8]) -> Option<LfsPointer<'_>> {
    if bytes.len() >= 1024 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if lines.next()? != "version https://git-lfs.github.com/spec/v1" {
        return None;
    }
    // Extension pointers need their configured transforms; a raw cached object is insufficient.
    let oid = lines.next()?.strip_prefix("oid sha256:")?;
    if oid.len() != 64
        || !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let size = lines.next()?.strip_prefix("size ")?;
    if size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_digit()) || lines.next().is_some()
    {
        return None;
    }
    Some(LfsPointer {
        oid,
        size: size.parse().ok()?,
    })
}

const MAX_STORAGE_CONFIG_BYTES: usize = 64 * 1024;

/// Reads one local setting with finite time and memory, without invoking LFS or its filters.
fn storage_config(root: &Path) -> Option<(ExitStatus, Vec<u8>)> {
    let mut child = spawn_git_stdout(root, &["config", "--null", "--get", "lfs.storage"]).ok()?;
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return None;
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(MAX_STORAGE_CONFIG_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let result = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    let bytes = match result {
        Ok(Ok(bytes)) if bytes.len() <= MAX_STORAGE_CONFIG_BYTES => bytes,
        _ => {
            stop_child(&mut child);
            let _ = reader.join();
            return None;
        }
    };
    let _ = reader.join();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some((status, bytes)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                stop_child(&mut child);
                return None;
            }
        }
    }
}

fn media_dir(common_dir: &Path, storage: Option<&[u8]>) -> Option<PathBuf> {
    let storage = match storage {
        Some(bytes) => {
            let bytes = bytes.strip_suffix(&[0])?;
            if bytes.contains(&0) {
                return None;
            }
            std::str::from_utf8(bytes).ok()?
        }
        None => "",
    };
    let storage = if storage.is_empty() {
        Path::new("lfs")
    } else {
        Path::new(storage)
    };
    #[cfg(windows)]
    if !storage.is_absolute()
        && (storage.has_root()
            || matches!(
                storage.components().next(),
                Some(std::path::Component::Prefix(_))
            ))
    {
        return None;
    }
    // Git LFS resolves relative storage against the common Git directory, including worktrees.
    let storage = if storage.is_absolute() {
        storage.to_owned()
    } else {
        common_dir.join(storage)
    };
    Some(storage.join("objects"))
}

fn lfs_media_dir(repo: &Repository) -> Option<PathBuf> {
    let (status, bytes) = storage_config(repo.workdir())?;
    let storage = if status.success() {
        Some(bytes.as_slice())
    } else if status.code() == Some(1) && bytes.is_empty() {
        None
    } else {
        return None;
    };
    media_dir(repo.commondir(), storage)
}

fn image_magic_matches(path: &str, bytes: &[u8]) -> bool {
    match mime_for(path) {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/bmp" => bytes.len() >= 14 && bytes.starts_with(b"BM"),
        "image/x-icon" => bytes.len() >= 6 && bytes.starts_with(b"\0\0\x01\0"),
        "image/avif" => {
            bytes.get(4..8) == Some(b"ftyp") && matches!(bytes.get(8..12), Some(b"avif" | b"avis"))
        }
        "image/svg+xml" => {
            let prefix = &bytes[..bytes.len().min(4096)];
            let Ok(text) = std::str::from_utf8(prefix) else {
                return false;
            };
            let text = text.trim_start_matches('\u{feff}').trim_start();
            text.starts_with("<svg") || text.starts_with("<?xml") && text.contains("<svg")
        }
        _ => false,
    }
}

fn cached_lfs_image(path: &str, pointer: &LfsPointer<'_>, media: &Path) -> Option<ImageSide> {
    let media = fs::canonicalize(media).ok()?;
    let object = media
        .join(&pointer.oid[..2])
        .join(&pointer.oid[2..4])
        .join(pointer.oid);
    // Never follow a cache entry that points outside its configured storage, or open a device.
    if !fs::symlink_metadata(&object).ok()?.file_type().is_file() {
        return None;
    }
    let object = fs::canonicalize(object).ok()?;
    if !object.starts_with(&media) {
        return None;
    }
    let file = fs::File::open(object).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() != pointer.size {
        return None;
    }
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Some(oversized_image(metadata.len()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 != pointer.size
        || bytes.len() > MAX_IMAGE_BYTES
        || !image_magic_matches(path, &bytes)
    {
        return None;
    }
    Some(image_side(path, &bytes))
}

fn image_with_cache(
    path: &str,
    bytes: &[u8],
    locate: impl FnOnce() -> Option<PathBuf>,
) -> ImageSide {
    lfs_pointer(bytes)
        .and_then(|pointer| cached_lfs_image(path, &pointer, &locate()?))
        .unwrap_or_else(|| image_side(path, bytes))
}

struct ImageReader<'a> {
    repo: &'a Repository,
    media: OnceCell<Option<PathBuf>>,
}

impl ImageReader<'_> {
    fn side(&self, path: &str, bytes: &[u8]) -> ImageSide {
        image_with_cache(path, bytes, || {
            self.media.get_or_init(|| lfs_media_dir(self.repo)).clone()
        })
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

fn blob_at(reader: &ImageReader<'_>, path: &str, spec: &str) -> Option<ImageSide> {
    let repo = reader.repo;
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
        .map(|_| reader.side(path, &bytes))
}

fn worktree_side(
    reader: &ImageReader<'_>,
    path: &str,
    full: &Path,
) -> AppResult<Option<ImageSide>> {
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
    Ok(Some(reader.side(path, &bytes)))
}

pub fn image_pair(repo: &Repository, source: &FileSource) -> AppResult<ImagePair> {
    let reader = ImageReader {
        repo,
        media: OnceCell::new(),
    };
    let (before, after) = match source {
        FileSource::Workdir { path, staged } => {
            let rel = safe_repo_path(path)?;
            if *staged {
                (
                    blob_at(&reader, &rel, &format!("HEAD:{rel}")),
                    blob_at(&reader, &rel, &format!(":0:{rel}")),
                )
            } else {
                let full = ensure_inside_workdir(repo, &rel)?;
                (
                    blob_at(&reader, &rel, &format!(":0:{rel}")),
                    worktree_side(&reader, &rel, &full)?,
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
                parent.and_then(|parent| blob_at(&reader, &old, &format!("{parent}:{old}"))),
                blob_at(&reader, &rel, &format!("{}:{rel}", commit.id)),
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
                blob_at(&reader, &old, &format!("{base}:{old}")),
                blob_at(&reader, &rel, &format!("{head}:{rel}")),
            )
        }
        FileSource::Stash { oid, path } => {
            let rel = safe_repo_path(path)?;
            let stash = peel_commit(repo, oid)?;
            let current = blob_at(&reader, &rel, &format!("{}:{rel}", stash.id)).or_else(|| {
                stash
                    .parents
                    .get(2)
                    .and_then(|parent| blob_at(&reader, &rel, &format!("{parent}:{rel}")))
            });
            (
                stash
                    .parents
                    .first()
                    .and_then(|parent| blob_at(&reader, &rel, &format!("{parent}:{rel}"))),
                current,
            )
        }
    };
    Ok(ImagePair { before, after })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture image";

    fn pointer(oid: &str, size: u64) -> Vec<u8> {
        format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {size}\n")
            .into_bytes()
    }

    fn object(media: &Path, bytes: &[u8]) -> PathBuf {
        let path = media.join(&OID[..2]).join(&OID[2..4]).join(OID);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn lfs_lookup_requires_a_strict_pointer_and_does_not_run_extensions() {
        let valid = pointer(OID, PNG.len() as u64);
        assert_eq!(lfs_pointer(&valid).unwrap().oid, OID);
        for invalid in [
            pointer("../../../outside", 10),
            pointer(&OID.to_uppercase(), 10),
            pointer(&"f".repeat(63), 10),
            pointer(&format!("{OID} --option"), 10),
            format!("version https://git-lfs.github.com/spec/v1\next-0-transform sha256:{OID}\noid sha256:{OID}\nsize 10\n").into_bytes(),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{OID}\nsize -1\n").into_bytes(),
        ] {
            let side = image_with_cache("image.png", &invalid, || panic!("invalid pointers must not locate storage"));
            assert!(side.lfs && side.data_url.is_none());
        }
    }

    #[test]
    fn storage_paths_follow_the_common_directory_and_keep_literal_names() {
        let temp = tempfile::tempdir().unwrap();
        let common = temp.path().join("repository metadata");
        assert_eq!(
            media_dir(&common, None).unwrap(),
            common.join("lfs/objects")
        );
        assert_eq!(
            media_dir(&common, Some(b"\0")).unwrap(),
            common.join("lfs/objects")
        );
        assert_eq!(
            media_dir(&common, Some(b"../shared cache\0")).unwrap(),
            common.join("../shared cache/objects")
        );
        let absolute = temp.path().join("shared cache");
        let config = format!("{}\0", absolute.display());
        assert_eq!(
            media_dir(&common, Some(config.as_bytes())).unwrap(),
            absolute.join("objects")
        );
        assert!(media_dir(&common, Some(b"unterminated")).is_none());
        assert!(media_dir(&common, Some(b"first\0second\0")).is_none());
        #[cfg(windows)]
        for ambiguous in [b"C:cache\0".as_slice(), b"\\cache\0".as_slice()] {
            assert!(media_dir(&common, Some(ambiguous)).is_none());
        }
        #[cfg(unix)]
        assert_eq!(
            media_dir(&common, Some(b"cache\\literal space\0")).unwrap(),
            common.join("cache\\literal space/objects")
        );
    }

    #[test]
    fn cached_images_replace_pointers_only_when_size_and_magic_match() {
        let temp = tempfile::tempdir().unwrap();
        let media = temp.path().join("cache/objects");
        let cached = object(&media, PNG);
        let bytes = pointer(OID, PNG.len() as u64);
        let side = image_with_cache("image.png", &bytes, || Some(media.clone()));
        assert!(!side.lfs && !side.too_large);
        assert_eq!(side.size, PNG.len() as u64);
        assert_eq!(
            side.data_url.unwrap(),
            image_side("image.png", PNG).data_url.unwrap()
        );

        fs::write(&cached, b"not an image").unwrap();
        let side = image_with_cache("image.png", &bytes, || Some(media.clone()));
        assert!(side.lfs && side.data_url.is_none());
        let bad_magic = vec![b'x'; PNG.len()];
        fs::write(&cached, bad_magic).unwrap();
        assert!(image_with_cache("image.png", &bytes, || Some(media.clone())).lfs);
        fs::remove_file(cached).unwrap();
        assert!(image_with_cache("image.png", &bytes, || Some(media.clone())).lfs);
        assert!(image_with_cache("image.png", &bytes, || None).lfs);
    }

    #[test]
    fn large_cached_objects_are_bounded_and_missing_cache_does_not_create_directories() {
        let temp = tempfile::tempdir().unwrap();
        let media = temp.path().join("cache/objects");
        let bytes = pointer(OID, PNG.len() as u64);
        assert!(image_with_cache("image.png", &bytes, || Some(media.clone())).lfs);
        assert!(!media.exists());
        let cached = object(&media, PNG);
        let size = MAX_IMAGE_BYTES as u64 + 1;
        fs::File::options()
            .write(true)
            .open(cached)
            .unwrap()
            .set_len(size)
            .unwrap();
        let side = image_with_cache("image.png", &pointer(OID, size), || Some(media));
        assert!(side.too_large && side.data_url.is_none());
        assert_eq!(side.size, size);
    }

    #[cfg(unix)]
    #[test]
    fn cache_symlinks_cannot_escape_the_configured_storage() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let media = temp.path().join("cache/objects");
        let cached = object(&media, PNG);
        let outside = temp.path().join("outside.png");
        fs::write(&outside, PNG).unwrap();
        fs::remove_file(&cached).unwrap();
        symlink(&outside, &cached).unwrap();
        let bytes = pointer(OID, PNG.len() as u64);
        assert!(image_with_cache("image.png", &bytes, || Some(media.clone())).lfs);
        fs::remove_file(&cached).unwrap();
        fs::remove_dir(cached.parent().unwrap()).unwrap();
        symlink(temp.path(), cached.parent().unwrap()).unwrap();
        fs::write(temp.path().join(OID), PNG).unwrap();
        assert!(image_with_cache("image.png", &bytes, || Some(media)).lfs);
    }

    fn git(root: &Path, args: &[&str]) {
        let output = git_command(require_git().unwrap())
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", root.join("absent-global-config"))
            .env_remove("GIT_CONFIG_PARAMETERS")
            .env("GIT_CONFIG_COUNT", "0")
            .env("GIT_AUTHOR_NAME", "Alice")
            .env("GIT_AUTHOR_EMAIL", "alice@example.com")
            .env("GIT_COMMITTER_NAME", "Alice")
            .env("GIT_COMMITTER_EMAIL", "alice@example.com")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn pointer_previews_use_relative_custom_storage_in_main_and_linked_worktrees() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--template=", "-b", "main"]);
        git(&root, &["config", "lfs.storage", "../../shared cache"]);
        fs::write(root.join("image.png"), pointer(OID, PNG.len() as u64)).unwrap();
        git(&root, &["add", "--", "image.png"]);
        git(&root, &["commit", "-m", "add fixture pointer"]);
        let media = temp.path().join("shared cache/objects");
        object(&media, PNG);
        fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\nchanged image").unwrap();
        let source = FileSource::Workdir {
            path: "image.png".to_owned(),
            staged: false,
        };
        let repo = open_at(&root).unwrap();
        let pair = image_pair(&repo, &source).unwrap();
        assert!(!pair.before.unwrap().lfs);
        assert_eq!(pair.after.unwrap().size, 21);

        let linked = temp.path().join("linked workspace");
        git(
            &root,
            &[
                "worktree",
                "add",
                "--detach",
                linked.to_str().unwrap(),
                "HEAD",
            ],
        );
        assert!(linked.join(".git").is_file());
        let repo = open_at(&linked).unwrap();
        let pair = image_pair(&repo, &source).unwrap();
        assert!(!pair.before.unwrap().lfs);
        assert!(!pair.after.unwrap().lfs);

        git(&root, &["config", "lfs.storage", "../../missing cache"]);
        let pair = image_pair(&repo, &source).unwrap();
        assert!(pair.before.unwrap().lfs && pair.after.unwrap().lfs);
        assert!(!temp.path().join("missing cache").exists());
    }
}
