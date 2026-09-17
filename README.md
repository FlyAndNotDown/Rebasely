# Rebasely

Desktop Git client built with Tauri 2, Rust (`git2`), React, and shadcn/ui.

Version 1 focuses on local repository workflows: open a repo, inspect the working tree, stage and discard, commit, switch/create branches, and read history with diffs.

## Requirements

- Node.js 22+
- Rust (stable)
- Windows: MSVC Build Tools and CMake (needed to compile vendored libgit2)

## Develop

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Current features

- Open a local repository (folder picker + recents)
- Working tree: staged / unstaged, stage, unstage, discard
- Commit with `user.name` / `user.email` from Git config
- Local branch list, checkout, and create
- Commit history and per-file diffs
- Light / dark theme

Push, pull, merge, and rebase are intentionally out of this first cut.
