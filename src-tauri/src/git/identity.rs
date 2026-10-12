use super::*;

pub fn read_git_identity() -> AppResult<GitIdentity> {
    // Global only. A plain `git config` would also see a repository discovered
    // from the process cwd and show a local override as the shared identity.
    Ok(GitIdentity {
        name: config_get_global("user.name").unwrap_or_default(),
        email: config_get_global("user.email").unwrap_or_default(),
    })
}

pub(super) fn global_gitconfig_path() -> AppResult<PathBuf> {
    let output = run_git(
        &std::env::temp_dir(),
        &["config", "--global", "--show-origin", "--list"],
    )?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let Some(rest) = line.strip_prefix("file:") else {
                continue;
            };
            let path = rest
                .split('\t')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches('"');
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| AppError::msg("Could not resolve home directory"))?;
    Ok(PathBuf::from(home).join(".gitconfig"))
}

pub fn write_git_identity(name: &str, email: &str) -> AppResult<()> {
    write_scoped_identity(name, email, true)
}

pub fn read_local_git_identity(repo: &Repository) -> AppResult<GitIdentity> {
    Ok(GitIdentity {
        name: config_get_local(repo, "user.name").unwrap_or_default(),
        email: config_get_local(repo, "user.email").unwrap_or_default(),
    })
}

pub fn write_local_git_identity(repo: &Repository, name: &str, email: &str) -> AppResult<()> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() {
        config_unset_local(repo, "user.name")?;
    } else {
        config_set_local(repo, "user.name", name)?;
    }
    if email.is_empty() {
        config_unset_local(repo, "user.email")?;
    } else {
        config_set_local(repo, "user.email", email)?;
    }
    Ok(())
}

fn write_scoped_identity(name: &str, email: &str, global: bool) -> AppResult<()> {
    let name = name.trim();
    let email = email.trim();
    if !global {
        return Ok(());
    }
    if name.is_empty() {
        config_unset_global("user.name")?;
    } else {
        config_set_global("user.name", name)?;
    }
    if email.is_empty() {
        config_unset_global("user.email")?;
    } else {
        config_set_global("user.email", email)?;
    }
    Ok(())
}
