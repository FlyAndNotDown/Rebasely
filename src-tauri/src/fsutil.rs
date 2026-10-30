use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Writes through a sibling temp file and a rename, so a crash mid-write leaves
/// the previous file in place instead of a truncated one.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut name = path.as_os_str().to_owned();
    name.push(format!(
        ".{}-{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = PathBuf::from(name);
    let written = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()
    })();
    if let Err(err) = written {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::write_atomic;
    use std::fs;

    #[test]
    fn replaces_the_file_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("rebasely-fsutil-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prefs.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();
        write_atomic(&path, b"{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn preserves_the_original_when_replacement_is_blocked() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;

        let dir =
            std::env::temp_dir().join(format!("rebasely-fsutil-locked-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prefs.json");
        fs::write(&path, b"original").unwrap();
        // Permit reads and writes, but block replacing the file's directory entry.
        let reader = OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(&path)
            .unwrap();

        let result = write_atomic(&path, b"updated");
        let contents = fs::read(&path).unwrap();
        let entries = fs::read_dir(&dir).unwrap().count();
        drop(reader);
        fs::remove_dir_all(&dir).unwrap();

        assert!(result.is_err());
        assert_eq!(contents, b"original");
        assert_eq!(entries, 1);
    }
}
