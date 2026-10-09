use super::*;

pub fn read_git_identity() -> AppResult<GitIdentity> {
    // The global file only. open_default also reads a repo discovered from the
    // process cwd, which would show a local override as the shared identity.
    let path = global_gitconfig_path()?;
    let cfg = if path.is_file() {
        git2::Config::open(&path).ok()
    } else {
        None
    };
    Ok(GitIdentity {
        name: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.name").ok())
            .unwrap_or_default(),
        email: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.email").ok())
            .unwrap_or_default(),
    })
}

pub(super) fn global_gitconfig_path() -> AppResult<PathBuf> {
    if let Ok(path) = git2::Config::find_global() {
        return Ok(path);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| AppError::msg("Could not resolve home directory"))?;
    Ok(PathBuf::from(home).join(".gitconfig"))
}

pub fn write_git_identity(name: &str, email: &str) -> AppResult<()> {
    write_identity_to_config(&global_gitconfig_path()?, name, email)
}

pub(super) fn local_gitconfig_path(repo: &Repository) -> PathBuf {
    repo.path().join("config")
}

pub fn read_local_git_identity(repo: &Repository) -> AppResult<GitIdentity> {
    let path = local_gitconfig_path(repo);
    let cfg = git2::Config::open(&path).ok();
    Ok(GitIdentity {
        name: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.name").ok())
            .unwrap_or_default(),
        email: cfg
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.email").ok())
            .unwrap_or_default(),
    })
}

pub fn write_local_git_identity(repo: &Repository, name: &str, email: &str) -> AppResult<()> {
    write_identity_to_config(&local_gitconfig_path(repo), name, email)
}

pub(super) fn write_identity_to_config(path: &Path, name: &str, email: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !path.exists() {
        fs::write(path, "")?;
    }
    let mut cfg = git2::Config::open(path)?;
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() {
        let _ = cfg.remove("user.name");
    } else {
        cfg.set_str("user.name", name)?;
    }
    if email.is_empty() {
        let _ = cfg.remove("user.email");
    } else {
        cfg.set_str("user.email", email)?;
    }
    Ok(())
}
