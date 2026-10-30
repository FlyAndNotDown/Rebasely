//! SSH keys in the user's `.ssh` folder.
//!
//! OpenSSH offers `id_ed25519`, `id_ecdsa`, and `id_rsa` on its own. Creating
//! a key, reading its public half, and printing its fingerprint are all done
//! by `ssh-keygen`. This module only picks files, checks names, and keeps a
//! copied private key private. Private key bytes are never parsed or returned.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};

const MAX_KEY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub algorithm: String,
    pub bits: Option<u32>,
    pub fingerprint: String,
    pub comment: String,
    pub public_key: String,
    pub encrypted: bool,
    pub default_identity: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyList {
    pub directory: String,
    pub directory_exists: bool,
    pub keygen_available: bool,
    pub keys: Vec<SshKeyInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyPreview {
    pub file_name: String,
    pub encrypted: bool,
    pub in_ssh_folder: bool,
    pub has_public: bool,
}

struct ListedKey {
    bits: u32,
    fingerprint: String,
    comment: String,
    algorithm: String,
}

enum Revealed {
    /// `ssh-keygen -y` printed the public key. The private key has no passphrase.
    Open(String),
    /// `ssh-keygen` asked for a passphrase.
    Encrypted,
    /// The file is a private key `ssh-keygen` could not read.
    Unknown,
}

pub fn list() -> AppResult<SshKeyList> {
    let directory = ssh_dir()?;
    let directory_exists = directory.is_dir();
    let keys = if directory_exists {
        list_in(&directory)?
    } else {
        Vec::new()
    };
    Ok(SshKeyList {
        directory: directory.to_string_lossy().into_owned(),
        directory_exists,
        keygen_available: find_ssh_keygen().is_some(),
        keys,
    })
}

pub fn preview(source: &str) -> AppResult<SshKeyPreview> {
    let source = PathBuf::from(source.trim());
    inspect_source(&source)?;
    let file_name = file_name_of(&source)?;
    let dest = ssh_dir()?.join(&file_name);
    let encrypted = match find_ssh_keygen() {
        Some(keygen) => matches!(reveal_public(&keygen, &source, ""), Revealed::Encrypted),
        None => false,
    };
    Ok(SshKeyPreview {
        encrypted,
        in_ssh_folder: same_file(&source, &dest),
        has_public: read_public_text(&public_path(&source)).is_some(),
        file_name,
    })
}

pub fn generate(
    name: &str,
    algorithm: &str,
    comment: &str,
    passphrase: &str,
) -> AppResult<SshKeyInfo> {
    let dir = ssh_dir()?;
    ensure_ssh_dir(&dir)?;
    generate_at(&dir, name, algorithm, comment, passphrase)
}

pub fn import(source: &str, passphrase: &str) -> AppResult<SshKeyInfo> {
    let source = PathBuf::from(source.trim());
    inspect_source(&source)?;
    let dir = ssh_dir()?;
    ensure_ssh_dir(&dir)?;
    import_at(&dir, &source, passphrase)
}

pub fn delete(name: &str) -> AppResult<()> {
    let dir = ssh_dir()?;
    delete_at(&dir, name)
}

fn generate_at(
    dir: &Path,
    name: &str,
    algorithm: &str,
    comment: &str,
    passphrase: &str,
) -> AppResult<SshKeyInfo> {
    let name = name.trim();
    let comment = comment.trim();
    validate_new_name(name)?;
    validate_line(comment, "The comment")?;
    validate_passphrase(passphrase)?;
    let path = child_path(dir, name)?;
    if fs::symlink_metadata(&path).is_ok() || fs::symlink_metadata(public_path(&path)).is_ok() {
        return Err(AppError::msg(format!("A key named {name} already exists.")));
    }
    let keygen = require_keygen()?;
    let temporary = tempfile::Builder::new()
        .prefix(".rebasely-key-")
        .tempdir_in(dir)?;
    #[cfg(windows)]
    restrict_windows_key(temporary.path())?;
    let temporary_key = temporary.path().join(name);
    let mut args = vec![
        OsString::from("-q"),
        OsString::from("-t"),
        OsString::from(keygen_type(algorithm)?),
    ];
    if algorithm == "rsa" {
        args.push(OsString::from("-b"));
        args.push(OsString::from("4096"));
    }
    args.push(OsString::from("-f"));
    args.push(temporary_key.as_os_str().to_owned());
    if passphrase.is_empty() {
        args.push(OsString::from("-N"));
        args.push(OsString::from(""));
    }
    if !comment.is_empty() {
        args.push(OsString::from("-C"));
        args.push(OsString::from(comment));
    }
    let output = run_keygen_with_passphrase(
        &keygen,
        &args,
        (!passphrase.is_empty()).then_some(passphrase),
    )?;
    if !output.status.success() {
        return Err(failed_keygen(&output, passphrase));
    }
    import_at(dir, &temporary_key, passphrase)
}

fn import_at(dir: &Path, source: &Path, passphrase: &str) -> AppResult<SshKeyInfo> {
    validate_passphrase(passphrase)?;
    let name = file_name_of(source)?;
    let dest = child_path(dir, &name)?;
    let already = same_file(source, &dest);
    if !already
        && (fs::symlink_metadata(&dest).is_ok() || fs::symlink_metadata(public_path(&dest)).is_ok())
    {
        return Err(AppError::msg(format!("A key named {name} already exists.")));
    }
    if !already {
        let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
        lock_private_key(temporary.path())?;
        std::io::copy(&mut File::open(source)?, temporary.as_file_mut())?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(&dest)
            .map_err(|error| error.error)?;
    } else {
        lock_private_key(&dest)?;
    }
    let mut created_public = false;
    match finish_import(&dest, source, passphrase, &mut created_public) {
        Ok(info) => Ok(info),
        Err(error) => {
            if !already {
                let _ = fs::remove_file(&dest);
                if created_public {
                    let _ = fs::remove_file(public_path(&dest));
                }
            }
            Err(error)
        }
    }
}

fn finish_import(
    dest: &Path,
    source: &Path,
    passphrase: &str,
    created_public: &mut bool,
) -> AppResult<SshKeyInfo> {
    let pub_dest = public_path(dest);
    if read_public_text(&pub_dest).is_some() {
        return describe_path(dest);
    }
    let sibling = public_path(source);
    if sibling != pub_dest {
        if let Some(line) = read_public_text(&sibling) {
            write_public(&pub_dest, &line)?;
            *created_public = true;
            return describe_path(dest);
        }
    }
    let keygen = require_keygen()?;
    let line = match reveal_public(&keygen, dest, passphrase) {
        Revealed::Open(line) => line,
        Revealed::Encrypted => {
            return Err(if passphrase.is_empty() {
                AppError::msg("This key has a passphrase. Enter it to add the key.")
            } else {
                AppError::msg("The passphrase was not accepted.")
            });
        }
        Revealed::Unknown => {
            return Err(AppError::msg("Could not read a public key from that file."));
        }
    };
    write_public(&pub_dest, &line)?;
    *created_public = true;
    describe_path(dest)
}

fn delete_at(dir: &Path, name: &str) -> AppResult<()> {
    let name = name.trim();
    validate_component(name)?;
    let path = child_path(dir, name)?;
    if !path.is_file() {
        return Err(AppError::msg("That key is no longer in your SSH folder."));
    }
    if !path_stays_in(dir, &path) {
        return Err(AppError::msg("That key is no longer in your SSH folder."));
    }
    let prefix = read_text_prefix(&path, 8192).unwrap_or_default();
    if !is_private_key_text(&prefix) {
        return Err(AppError::msg("That file is not an OpenSSH private key."));
    }
    fs::remove_file(&path)?;
    remove_public(dir, &path);
    Ok(())
}

fn list_in(dir: &Path) -> AppResult<Vec<SshKeyInfo>> {
    let mut keys = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !is_listed_private_name(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_KEY_BYTES {
            continue;
        }
        let Ok(prefix) = read_text_prefix(&path, 8192) else {
            continue;
        };
        if !is_private_key_text(&prefix) {
            continue;
        }
        if let Ok(info) = describe_path(&path) {
            keys.push(info);
        }
    }
    keys.sort_by(|left, right| {
        identity_rank(&left.name)
            .cmp(&identity_rank(&right.name))
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
    });
    Ok(keys)
}

fn describe_path(path: &Path) -> AppResult<SshKeyInfo> {
    let name = file_name_of(path)?;
    let pub_path = public_path(path);
    let stored = read_public_text(&pub_path);
    let mut public_key = stored.clone().unwrap_or_default();
    let mut encrypted = false;
    let mut listed = None;
    if let Some(keygen) = find_ssh_keygen() {
        match reveal_public(&keygen, path, "") {
            Revealed::Open(line) => {
                if public_key.is_empty() {
                    public_key = line;
                }
            }
            Revealed::Encrypted => encrypted = true,
            Revealed::Unknown => {}
        }
        listed = if pub_path.is_file() {
            list_fingerprint(&keygen, &pub_path)
        } else if !encrypted && !public_key.is_empty() {
            list_fingerprint(&keygen, path)
        } else {
            None
        };
    }
    Ok(SshKeyInfo {
        algorithm: listed
            .as_ref()
            .map(|listed| listed.algorithm.clone())
            .unwrap_or_default(),
        bits: listed.as_ref().map(|listed| listed.bits),
        fingerprint: listed
            .as_ref()
            .map(|listed| listed.fingerprint.clone())
            .unwrap_or_default(),
        comment: listed
            .as_ref()
            .map(|listed| listed.comment.clone())
            .unwrap_or_default(),
        encrypted,
        default_identity: is_default_identity(&name),
        public_key,
        name,
    })
}

/// `ssh-keygen -y` prints the public key. Empty passphrases use `-P ""` to
/// detect protected keys; nonempty values travel through the private askpass
/// endpoint rather than process arguments or environment variables.
fn reveal_public(keygen: &Path, private_key: &Path, passphrase: &str) -> Revealed {
    let mut args = vec![
        OsString::from("-y"),
        OsString::from("-f"),
        private_key.as_os_str().to_owned(),
    ];
    if passphrase.is_empty() {
        args.extend([OsString::from("-P"), OsString::from("")]);
    }
    let Ok(output) = run_keygen_with_passphrase(
        keygen,
        &args,
        (!passphrase.is_empty()).then_some(passphrase),
    ) else {
        return Revealed::Unknown;
    };
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        return match public_line(&text) {
            Some(line) => Revealed::Open(line),
            None => Revealed::Unknown,
        };
    }
    if passphrase_rejected(&output) {
        Revealed::Encrypted
    } else {
        Revealed::Unknown
    }
}

/// `ssh-keygen -l -E sha256` prints `256 SHA256:… comment (ED25519)`.
fn list_fingerprint(keygen: &Path, file: &Path) -> Option<ListedKey> {
    let file = file.as_os_str().to_owned();
    let sha = run_keygen(
        keygen,
        &[
            OsString::from("-l"),
            OsString::from("-E"),
            OsString::from("sha256"),
            OsString::from("-f"),
            file.clone(),
        ],
    )
    .ok();
    if let Some(parsed) = sha.as_ref().and_then(parse_keygen_output) {
        return Some(parsed);
    }
    let plain = run_keygen(keygen, &[OsString::from("-l"), OsString::from("-f"), file]).ok()?;
    parse_keygen_output(&plain)
}

fn parse_keygen_output(output: &Output) -> Option<ListedKey> {
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(parse_keygen_list_line)
}

fn parse_keygen_list_line(line: &str) -> Option<ListedKey> {
    let line = line.trim().trim_end_matches('\r');
    let (bits, rest) = line.split_once(' ')?;
    let bits = bits.parse().ok()?;
    let rest = rest.trim_start();
    let (fingerprint, rest) = rest.split_once(char::is_whitespace)?;
    if !fingerprint.starts_with("SHA256:") && !fingerprint.starts_with("MD5:") {
        return None;
    }
    let rest = rest.trim();
    if !rest.ends_with(')') {
        return None;
    }
    let open = rest.rfind('(')?;
    let close = rest.len() - 1;
    if open >= close {
        return None;
    }
    let comment = rest[..open].trim().to_string();
    let kind = rest[open + 1..close].trim();
    Some(ListedKey {
        bits,
        fingerprint: fingerprint.to_string(),
        comment,
        algorithm: algorithm_name(kind).to_string(),
    })
}

fn algorithm_name(kind: &str) -> &'static str {
    let kind = kind.to_ascii_lowercase();
    if kind.contains("ed25519") {
        "ed25519"
    } else if kind.contains("ecdsa") {
        "ecdsa"
    } else if kind.contains("rsa") {
        "rsa"
    } else if kind.contains("dsa") || kind.contains("dss") {
        "dsa"
    } else {
        ""
    }
}

fn inspect_source(path: &Path) -> AppResult<()> {
    let meta = fs::metadata(path).map_err(|_| AppError::msg("Choose a private key file."))?;
    if !meta.is_file() {
        return Err(AppError::msg("Choose a private key file."));
    }
    if meta.len() > MAX_KEY_BYTES {
        return Err(AppError::msg("That file is too large to be a private key."));
    }
    let name = file_name_of(path)?;
    if is_public_name(&name) {
        return Err(AppError::msg(
            "Choose the private key file. A public key ends in .pub.",
        ));
    }
    if is_putty_name(&name) {
        return Err(AppError::msg(
            "PuTTY keys (.ppk) have to be exported as OpenSSH keys first.",
        ));
    }
    validate_new_name(&name)?;
    let prefix = read_text_prefix(path, 8192)?;
    if is_putty_text(&prefix) {
        return Err(AppError::msg(
            "PuTTY keys (.ppk) have to be exported as OpenSSH keys first.",
        ));
    }
    if !is_private_key_text(&prefix) {
        return Err(AppError::msg("That file is not an OpenSSH private key."));
    }
    Ok(())
}

fn public_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find_map(|line| {
        let line = line.strip_prefix('\u{feff}').unwrap_or(line).trim();
        let kind = line.split_whitespace().next().unwrap_or("");
        if kind.starts_with("ssh-") || kind.starts_with("ecdsa-") || kind.starts_with("sk-") {
            Some(line.to_string())
        } else {
            None
        }
    })
}

fn is_private_key_text(text: &str) -> bool {
    let text = text.trim_start().strip_prefix('\u{feff}').unwrap_or(text);
    text.starts_with("-----BEGIN ") && text.contains("PRIVATE KEY-----")
}

fn is_putty_text(text: &str) -> bool {
    text.trim_start()
        .strip_prefix('\u{feff}')
        .unwrap_or(text.trim_start())
        .starts_with("PuTTY-User-Key-File-")
}

fn is_default_identity(name: &str) -> bool {
    matches!(
        name,
        "id_ed25519"
            | "id_ecdsa"
            | "id_rsa"
            | "id_ed25519_sk"
            | "id_ecdsa_sk"
            | "id_xmss"
            | "id_dsa"
    )
}

fn identity_rank(name: &str) -> u8 {
    match name {
        "id_ed25519" => 0,
        "id_ecdsa" => 1,
        "id_rsa" => 2,
        "id_ed25519_sk" => 3,
        "id_ecdsa_sk" => 4,
        "id_xmss" => 5,
        "id_dsa" => 6,
        _ => 7,
    }
}

fn keygen_type(algorithm: &str) -> AppResult<&'static str> {
    match algorithm {
        "ed25519" => Ok("ed25519"),
        "rsa" => Ok("rsa"),
        _ => Err(AppError::msg("Choose an Ed25519 or RSA key.")),
    }
}

fn validate_new_name(name: &str) -> AppResult<()> {
    validate_component(name)?;
    if name.starts_with('.')
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(AppError::msg(
            "Use letters, numbers, dots, hyphens, and underscores in the file name.",
        ));
    }
    Ok(())
}

fn validate_component(name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.len() > 128
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
        || is_public_name(name)
        || is_reserved_name(name)
    {
        return Err(AppError::msg("Enter a file name such as id_ed25519."));
    }
    Ok(())
}

fn validate_line(value: &str, label: &str) -> AppResult<()> {
    if value.contains(['\n', '\r', '\0']) {
        return Err(AppError::msg(format!("{label} has to be a single line.")));
    }
    if value.len() > 1024 {
        return Err(AppError::msg(format!("{label} is too long.")));
    }
    Ok(())
}

fn validate_passphrase(value: &str) -> AppResult<()> {
    validate_line(value, "The passphrase")?;
    // OpenSSH's askpass reader reserves one byte in its 1024-byte buffer for NUL.
    if value.len() > 1023 {
        return Err(AppError::msg("The passphrase is too long."));
    }
    Ok(())
}

fn is_listed_private_name(name: &str) -> bool {
    !name.starts_with('.')
        && !is_public_name(name)
        && !is_putty_name(name)
        && !is_reserved_name(name)
}

fn is_public_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".pub")
}

fn is_putty_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".ppk")
}

fn is_reserved_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "config"
            | "known_hosts"
            | "known_hosts.old"
            | "authorized_keys"
            | "authorized_keys2"
            | "environment"
            | "rc"
            | "moduli"
    ) || name.starts_with("known_hosts")
}

fn file_name_of(path: &Path) -> AppResult<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::msg("Enter a file name such as id_ed25519."))
}

fn child_path(dir: &Path, name: &str) -> AppResult<PathBuf> {
    let path = dir.join(name);
    if path.parent() != Some(dir) {
        return Err(AppError::msg("Enter a file name such as id_ed25519."));
    }
    Ok(path)
}

fn public_path(private_key: &Path) -> PathBuf {
    let mut name = private_key.as_os_str().to_owned();
    name.push(".pub");
    PathBuf::from(name)
}

fn same_file(left: &Path, right: &Path) -> bool {
    if let (Ok(left), Ok(right)) = (left.canonicalize(), right.canonicalize()) {
        return left == right;
    }
    fold_path(left) == fold_path(right)
}

fn path_stays_in(dir: &Path, path: &Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(dir), Ok(path)) => path.starts_with(dir),
        _ => path.parent() == Some(dir),
    }
}

fn fold_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn remove_public(dir: &Path, private_key: &Path) {
    let path = public_path(private_key);
    if path.is_file() && path_stays_in(dir, &path) {
        let _ = fs::remove_file(path);
    }
}

fn write_public(path: &Path, line: &str) -> AppResult<()> {
    let mut text = line.trim().to_string();
    text.push('\n');
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));
    }
    Ok(())
}

fn read_public_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return None;
    }
    public_line(&fs::read_to_string(path).ok()?)
}

fn read_text_prefix(path: &Path, limit: usize) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut buf = vec![0_u8; limit];
    let read = file.read(&mut buf)?;
    buf.truncate(read);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn ssh_dir() -> AppResult<PathBuf> {
    let home = home_dir().ok_or_else(|| AppError::msg("Could not find your home folder."))?;
    Ok(home.join(".ssh"))
}

fn home_dir() -> Option<PathBuf> {
    let value = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    }?;
    if value.is_empty() {
        None
    } else {
        Some(PathBuf::from(value))
    }
}

fn ensure_ssh_dir(dir: &Path) -> AppResult<()> {
    if dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn require_keygen() -> AppResult<PathBuf> {
    find_ssh_keygen().ok_or_else(|| AppError::msg("ssh-keygen was not found."))
}

fn find_ssh_keygen() -> Option<PathBuf> {
    if let Some(path) = crate::locate::which("ssh-keygen") {
        return Some(path);
    }
    if let Some(git) = crate::git::active_git() {
        if let Some(path) = keygen_near(Path::new(&git)) {
            return Some(path);
        }
    }
    fallback_keygen_paths()
        .into_iter()
        .find(|path| path.is_file())
}

fn keygen_near(git: &Path) -> Option<PathBuf> {
    let name = keygen_file_name();
    let mut current = git.parent();
    for _ in 0..5 {
        let dir = current?;
        let nested = dir.join("usr").join("bin").join(name);
        if nested.is_file() {
            return Some(nested);
        }
        let sibling = dir.join(name);
        if sibling.is_file() {
            return Some(sibling);
        }
        current = dir.parent();
    }
    None
}

fn keygen_file_name() -> &'static str {
    if cfg!(windows) {
        "ssh-keygen.exe"
    } else {
        "ssh-keygen"
    }
}

fn fallback_keygen_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut paths = vec![PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh-keygen.exe")];
        if let Some(program) = std::env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(program).join(r"Git\usr\bin\ssh-keygen.exe"));
        }
        if let Some(program) = std::env::var_os("ProgramFiles(x86)") {
            paths.push(PathBuf::from(program).join(r"Git\usr\bin\ssh-keygen.exe"));
        }
        paths
    }
    #[cfg(not(windows))]
    {
        vec![
            PathBuf::from("/usr/bin/ssh-keygen"),
            PathBuf::from("/usr/local/bin/ssh-keygen"),
            PathBuf::from("/opt/homebrew/bin/ssh-keygen"),
        ]
    }
}

fn run_keygen(program: &Path, args: &[OsString]) -> AppResult<Output> {
    run_keygen_with_passphrase(program, args, None)
}

fn run_keygen_with_passphrase(
    program: &Path,
    args: &[OsString],
    passphrase: Option<&str>,
) -> AppResult<Output> {
    let prompt = passphrase
        .map(crate::askpass::SecretPrompt::new)
        .transpose()?;
    let mut command = crate::platform::background_command(program);
    command.args(args);
    // Do not inherit the Git UI prompt route. A protected key uses its own
    // operation-owned endpoint, without putting the secret in argv or env.
    command.env("SSH_ASKPASS", "");
    command.env("SSH_ASKPASS_REQUIRE", "never");
    command.env("GIT_ASKPASS", "");
    command.env("DISPLAY", "");
    if let Some(prompt) = &prompt {
        command.envs(prompt.environment());
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|err| AppError::msg(format!("Could not run ssh-keygen: {err}")))?;
    let pid = child.id();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    match receiver.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(output)) => Ok(output),
        _ => {
            kill_pid(pid);
            Err(AppError::msg("ssh-keygen did not finish."))
        }
    }
}

fn failed_keygen(output: &Output, passphrase: &str) -> AppError {
    if passphrase_rejected(output) {
        return if passphrase.is_empty() {
            AppError::msg("This key has a passphrase. Enter it to add the key.")
        } else {
            AppError::msg("The passphrase was not accepted.")
        };
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = format!("{stderr}\n{stdout}");
    let text = if passphrase.is_empty() {
        text
    } else {
        text.replace(passphrase, "[redacted]")
    };
    if text.contains("PRIVATE KEY") || text.len() > 500 {
        return AppError::msg("ssh-keygen failed.");
    }
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.to_ascii_lowercase().contains("passphrase"));
    match line {
        Some(line) => AppError::msg(line.to_string()),
        None => AppError::msg("ssh-keygen failed."),
    }
}

fn passphrase_rejected(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lower = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    lower.contains("incorrect passphrase")
        || lower.contains("bad passphrase")
        || lower.contains("passphrase is too short")
        || lower.contains("passphrase too short")
}

fn kill_pid(pid: u32) {
    crate::platform::kill_process_tree(pid);
}

/// OpenSSH refuses a private key when another account can read it. `ssh-keygen`
/// sets that up on create; a copied file keeps the source permissions.
fn lock_private_key(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        restrict_windows_key(path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn restrict_windows_key(path: &Path) -> AppResult<()> {
    let Some(user) = std::env::var("USERNAME")
        .ok()
        .filter(|user| !user.is_empty() && !user.contains([':', '(', ')']))
    else {
        return Err(AppError::msg(
            "Could not identify the current account for SSH key permissions.",
        ));
    };
    let file = path.as_os_str().to_owned();
    let user = std::env::var("USERDOMAIN")
        .ok()
        .filter(|domain| !domain.is_empty())
        .map(|domain| format!("{domain}\\{user}"))
        .unwrap_or(user);
    let rights = if path.is_dir() { "(OI)(CI)(F)" } else { "(F)" };
    let grant = OsString::from(format!("{user}:{rights}"));
    run_icacls(&[file.clone(), OsString::from("/grant:r"), grant])?;
    run_icacls(&[file.clone(), OsString::from("/inheritance:r")])?;
    for group in ["*S-1-1-0", "*S-1-5-32-545", "*S-1-5-11"] {
        run_icacls(&[
            file.clone(),
            OsString::from("/remove"),
            OsString::from(group),
        ])?;
    }
    Ok(())
}

#[cfg(windows)]
fn run_icacls(args: &[OsString]) -> AppResult<()> {
    let status = crate::platform::background_command("icacls")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(AppError::msg(
            "Could not restrict access to the private SSH key.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn importing_a_key_never_overwrites_existing_private_or_public_files() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        let key = source.join("id_example");
        fs::write(&key, "example key").unwrap();
        let existing = destination.join("id_example");
        fs::write(&existing, "keep private contents").unwrap();
        assert!(import_at(&destination, &key, "").is_err());
        assert_eq!(
            fs::read_to_string(&existing).unwrap(),
            "keep private contents"
        );
        fs::remove_file(&existing).unwrap();
        fs::write(public_path(&existing), "keep public contents").unwrap();
        assert!(import_at(&destination, &key, "").is_err());
        assert_eq!(
            fs::read_to_string(public_path(&existing)).unwrap(),
            "keep public contents"
        );
        assert!(!existing.exists());
    }

    #[test]
    fn publishing_a_public_key_never_truncates_an_existing_file() {
        let temporary = tempfile::tempdir().unwrap();
        let public = temporary.path().join("id_example.pub");
        fs::write(&public, "keep existing contents").unwrap();
        assert!(write_public(&public, "ssh-ed25519 AAAA alice@example.com").is_err());
        assert_eq!(
            fs::read_to_string(public).unwrap(),
            "keep existing contents"
        );
    }

    #[test]
    fn keygen_errors_do_not_return_the_supplied_passphrase() {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let output = Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: Vec::new(),
            stderr: b"Could not use example-secret for this key".to_vec(),
        };
        let message = failed_keygen(&output, "example-secret").to_string();
        assert!(!message.contains("example-secret"));
        assert!(message.contains("[redacted]"));
    }

    #[test]
    fn parses_ssh_keygen_list_output() {
        let listed = parse_keygen_list_line(
            "256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ada@example.com (ED25519)",
        )
        .unwrap();
        assert_eq!(listed.bits, 256);
        assert_eq!(listed.algorithm, "ed25519");
        assert_eq!(listed.comment, "ada@example.com");
        assert!(listed.fingerprint.starts_with("SHA256:"));
        let rsa = parse_keygen_list_line("4096 SHA256:abc work key (RSA)").unwrap();
        assert_eq!(rsa.bits, 4096);
        assert_eq!(rsa.algorithm, "rsa");
        assert_eq!(rsa.comment, "work key");
    }

    #[test]
    fn rejects_path_components_in_key_names() {
        assert!(validate_new_name("id_ed25519").is_ok());
        assert!(validate_new_name("../id_ed25519").is_err());
        assert!(validate_new_name("id_ed25519.pub").is_err());
        assert!(validate_new_name("config").is_err());
        assert!(validate_new_name("known_hosts.old").is_err());
        assert!(is_putty_text("PuTTY-User-Key-File-3: ssh-ed25519\n"));
        assert!(validate_passphrase(&"x".repeat(1023)).is_ok());
        assert!(validate_passphrase(&"x".repeat(1024)).is_err());
    }

    #[test]
    fn lists_private_keys_and_skips_the_rest_of_the_folder() {
        let dir = temp_dir("list");
        let _keep = RemoveDir(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("id_ed25519"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-body\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        fs::write(dir.join("config"), "Host *\n").unwrap();
        fs::write(dir.join("known_hosts"), "github.com ssh-ed25519 AAAA\n").unwrap();
        fs::write(dir.join("orphan.pub"), "ssh-ed25519 AAAA\n").unwrap();
        fs::write(dir.join("work.ppk"), "PuTTY-User-Key-File-3:\n").unwrap();
        let keys = list_in(&dir).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].name, "id_ed25519");
        assert!(keys[0].default_identity);
    }

    #[test]
    fn finds_ssh_keygen_beside_a_git_install() {
        let root = temp_dir("near");
        let _keep = RemoveDir(&root);
        let bin = root.join("usr").join("bin");
        fs::create_dir_all(&bin).unwrap();
        let keygen = bin.join(keygen_file_name());
        fs::write(&keygen, b"").unwrap();
        let git = root
            .join("cmd")
            .join(if cfg!(windows) { "git.exe" } else { "git" });
        fs::create_dir_all(git.parent().unwrap()).unwrap();
        fs::write(&git, b"").unwrap();
        assert_eq!(keygen_near(&git).unwrap(), keygen);
    }

    #[test]
    fn generates_an_ed25519_key_when_ssh_keygen_is_installed() {
        let Some(_) = find_ssh_keygen() else {
            return;
        };
        let dir = temp_dir("gen");
        let _keep = RemoveDir(&dir);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let key = generate_at(&dir, "id_ed25519", "ed25519", "ada@example.com", "").unwrap();
        assert_eq!(key.algorithm, "ed25519");
        assert_eq!(key.bits, Some(256));
        assert_eq!(key.comment, "ada@example.com");
        assert!(key.fingerprint.starts_with("SHA256:"));
        assert!(key.public_key.starts_with("ssh-ed25519 "));
        assert!(key.public_key.contains("ada@example.com"));
        assert!(!key.encrypted);
        assert!(generate_at(&dir, "id_ed25519", "ed25519", "", "").is_err());
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::copy(dir.join("id_ed25519"), outside.join("id_work")).unwrap();
        fs::copy(dir.join("id_ed25519.pub"), outside.join("id_work.pub")).unwrap();
        let imported = import_at(&dir, &outside.join("id_work"), "").unwrap();
        assert_eq!(imported.name, "id_work");
        assert_eq!(imported.comment, "ada@example.com");
        assert!(!imported.default_identity);
        delete_at(&dir, "id_work").unwrap();
        assert!(!dir.join("id_work").exists());
        assert!(!dir.join("id_work.pub").exists());
        assert!(delete_at(&dir, "../id_ed25519").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("id_ed25519"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn protected_keys_generate_and_import_through_the_app_askpass_helper() {
        if find_ssh_keygen().is_none() || crate::askpass::test_helper_executable().is_none() {
            eprintln!(
                "Skipping protected-key integration: build the app and install ssh-keygen first."
            );
            return;
        }
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("destination");
        let source = temporary.path().join("source");
        fs::create_dir(&destination).unwrap();
        fs::create_dir(&source).unwrap();
        let passphrase = "example protected passphrase";
        let generated = generate_at(
            &destination,
            "id_protected",
            "ed25519",
            "alice@example.com",
            passphrase,
        )
        .unwrap();
        assert!(generated.encrypted);
        assert_eq!(generated.algorithm, "ed25519");
        assert_eq!(generated.comment, "alice@example.com");
        let private = destination.join("id_protected");
        let imported_source = source.join("id_imported");
        fs::copy(&private, &imported_source).unwrap();
        let imported = import_at(&destination, &imported_source, passphrase).unwrap();
        assert!(imported.encrypted);
        assert_eq!(imported.fingerprint, generated.fingerprint);
        assert_eq!(
            imported
                .public_key
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>(),
            generated
                .public_key
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
        );
        let rejected_source = source.join("id_rejected");
        fs::copy(&private, &rejected_source).unwrap();
        let error =
            import_at(&destination, &rejected_source, "wrong example passphrase").unwrap_err();
        assert!(error.to_string().contains("passphrase was not accepted"));
        assert!(!destination.join("id_rejected").exists());
        assert!(!destination.join("id_rejected.pub").exists());
    }

    struct RemoveDir<'a>(&'a Path);

    impl Drop for RemoveDir<'_> {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0);
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rebasely-ssh-{name}-{}", std::process::id()))
    }
}
