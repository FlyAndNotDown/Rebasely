# Rebasely

Rebasely is a desktop Git client for the work that sits between an editor and the command line: reading a working tree, reviewing history, and finishing branch operations without leaving the repository.

It is a native window built with Tauri 2. The interface is React. Repository work runs in Rust by calling the `git` executable, so what the window shows is what Git itself would do. Several repositories stay open in tabs, and the open set is restored on the next launch.

## Design

The window is a view of a real Git repository. Staging, commits, rebase, and push invoke `git` itself, so Git LFS, hooks, commit and tag signing, and sparse checkout follow the same rules as the command line.

Every repository read and write goes through `git` and the result is parsed in Rust. The UI never starts Git on its own; every call is a Tauri command.

Long-running commands can be cancelled. Cancelling stops the Git process and the helpers it launched, then removes lock files that command created. Credential prompts return to the window through an askpass helper. Background fetches run with prompts turned off, so an automatic refresh does not open a password dialog.

The work tree is watched for changes and the open snapshot refreshes from disk.

## What it covers

**Changes.** Stage, unstage, and discard a file, a hunk, or a single line. Commit, amend, commit and push, and undo the last commit. Changed files can be shown as a list or a folder tree, with multi-select and keyboard control. Selected files can be stashed or added to `.gitignore`.

**Diffs.** Inline or side by side, with syntax highlighting and hidden whitespace. Images compare side by side, by swipe, or as an onion skin.

**History.** A commit graph with multi-select, comparison of two commits or branches, and search by author, path, content, or date. Reflog is available when a branch needs to be put back.

**Branches and remotes.** Create, check out, and delete branches. Delete a branch on the remote as well. Push and delete tags. Fetch, pull with merge or rebase, push, and publish a branch. Each of those can be cancelled, and credentials are requested in the app.

**Rewriting history.** Merge, rebase, interactive rebase, cherry-pick, revert, and reset. A rebase or cherry-pick in progress continues from the commit box, including an edited message. Conflicts resolve per hunk, or in the configured merge tool.

**Stash, files, and structure.** Save, apply, pop, and drop stashes, and diff a stash file by file. Browse the tree with blame and per-file history. Submodules and worktrees are listed and operated on from the same window. Create and apply patches.

**Workspace.** Open, clone, and switch repositories in tabs. Recents and the open tabs come back on launch. Open a file in an editor, or a diff in the configured diff tool. A command palette (`Ctrl+K`) lists the same actions as the keyboard shortcuts. The theme is light, dark, or system, and the window chrome follows the resolved theme.

## Architecture

```text
React workspace
  changes, history, stash, files, dialogs
        │  Tauri commands
        ▼
Rust backend
  ├── git         status, log, blame, diffs, writes, remotes
  ├── askpass     credential prompts back into the window
  ├── notify      work-tree refresh
  └── session     open tabs and recents
```

Disk and process work runs off the UI thread. Session saves stay ordered on the main thread so rapid tab changes land in the sequence they were sent.

Commands the user starts can be cancelled by id. A background fetch uses the same Git path with terminal prompts, the askpass dialog, and the system credential window suppressed, and fails quietly if authentication is required.

## Repository layout

```text
src/                      React application
  components/             panes, dialogs, and UI primitives
  state/                  tabs, session, and the Git command client
  lib/                    diffs, commit graph, shortcuts, formatting
src-tauri/src/
  git/                    repository operations
  askpass.rs              credential helper
  watch.rs                work-tree notifications
  session.rs              restored tabs
  recents.rs              recently opened repositories
  editor.rs               external editors
  terminal.rs             external terminals
  prefs.rs                window preferences
```

## Stack

| Layer | Choice |
| --- | --- |
| Window | Tauri 2 |
| Interface | React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Repository | Rust and the `git` executable |
| Watching | `notify` |

Release builds use a single codegen unit, link-time optimization, and stripped symbols.

## Requirements

- Node.js 22+
- Rust (stable)
- Git on `PATH`

## Develop

```bash
npm install
npm run dev
```

## Check

```bash
npm run check       # typecheck, lint, and frontend tests
npm run check:rust  # rustfmt, clippy, and the Rust tests
npm run check:all   # both
```


## Build

```bash
npm run build
```

## Shortcuts

Shortcuts use Ctrl on Windows and Linux, and Command on macOS.

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl+K` or `F1` |
| Open repository | `Ctrl+O` |
| Close repository | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Changes, History, Stash, Files | `Ctrl+1` … `Ctrl+4` |
| Fetch, pull, push | `Ctrl+Shift+F`, `Ctrl+Shift+L`, `Ctrl+Shift+U` |
| New branch | `Ctrl+Shift+N` |
| Stash all | `Ctrl+Shift+S` |
| Reflog | `Ctrl+Shift+R` |
| Open in editor | `Ctrl+E` |
| Open terminal | `` Ctrl+` `` |
| Settings | `Ctrl+,` |
