![Rebasely — a unified version control client](site/public/assets/hero.svg)

<p align="center">
  <strong>Git and Perforce. A clearer view of every change.</strong><br><br>
  <a href="https://flyandnotdown.github.io/Rebasely/en/">Website</a> ·
  <a href="https://github.com/FlyAndNotDown/Rebasely/releases/latest">Download</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="README.zh-CN.md">Chinese</a>
</p>

Rebasely is an open-source desktop client for **Git and Perforce**, built with
React, TypeScript, Tauri, and Rust. Review the details, understand the history,
and prepare your next change in one focused workspace.

## See the work clearly

- **Review precisely.** Read unified or split text diffs, compare images, and
  stage Git changes by file, hunk, or individual line.
- **Understand the context.** Explore Git commit graphs, branches, and file
  history; review Perforce changelists and file revisions.
- **Keep projects close.** Switch repository tabs, find actions in the command
  palette, and use familiar shortcuts with light or dark themes.
- **Use your existing tools.** Repository operations run through Git and the
  Perforce CLI, preserving their configuration and command-line behavior.

| Git | Perforce |
| --- | --- |
| Open, clone, or initialize repositories | Connect or create a workspace |
| Stage, commit, and inspect history | Organize pending changelists and review revisions |
| Work with branches, stashes, and worktrees | Sync, reconcile, shelve, and submit |
| Review submodules and Git LFS workflows | Browse workspace and depot files |
| Rename branches, set upstreams, and edit remote URLs | Rename or move files, lock submissions, and undo revisions |
| Merge, rebase, and cherry-pick commits | Preview single-file integration in classic workspaces |

Try the [interactive Git and Perforce demo](https://flyandnotdown.github.io/Rebasely/en/#features).
It uses invented data and never changes a real repository.

## Get started

1. [Download the latest release](https://github.com/FlyAndNotDown/Rebasely/releases/latest)
   for **macOS Apple Silicon** or **Windows x64**.
2. Install **Git** for Git repositories, or the **Perforce CLI (`p4`)** for
   Perforce workspaces. Select the executable in Settings if needed.
3. Open a local folder, clone a Git repository, or connect to Perforce.

The app supports English and Simplified Chinese, follows your system language
by default, and lets you choose a language in Settings. The website follows
your browser language and includes a language switcher. English is the fallback.

Usage analytics is enabled by default. Google Analytics receives a random
installation ID, coarse app usage and foreground time, and basic device
information. Repository content, paths, and credentials are excluded. Turn it
off in **Settings → General → Share usage analytics**.

Diagnostic files stay on your device and are not uploaded automatically.
Remote repository operations connect to the servers you configure.

## Build from source

Install Node.js 22.13+ on the 22.x line, 24.x, or 26+, stable Rust, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
Linux builds require the Linux platform dependencies.

```sh
npm ci
npm run dev
```

To produce an application bundle:

```sh
npm run build
```

See the [development guide](docs/development.md) for the project structure and
checks. Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md); agents working
on the codebase should also read [AGENTS.md](AGENTS.md).

## Feedback and security

Report reproducible problems or suggest improvements in
[Issues](https://github.com/FlyAndNotDown/Rebasely/issues). Remove credentials,
private hosts, repository details, and local paths from attachments.
For vulnerabilities, follow the [security policy](SECURITY.md).

## License

[MIT](LICENSE)
