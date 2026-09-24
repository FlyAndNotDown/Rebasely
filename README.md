# Rebasely

Desktop Git client built with Tauri 2, Rust (`git2` plus the `git` CLI), React, and shadcn/ui.

## Requirements

- Node.js 22+
- Rust (stable)
- Git on `PATH` (status, log, blame, rebase, and remote operations shell out to it)
- Windows: MSVC Build Tools and CMake (needed to compile vendored libgit2)

## Develop

```bash
npm install
npm run dev
```

## Check

```bash
npm run typecheck
npm run lint
npm test
cd src-tauri && cargo test
```

## Build

```bash
npm run build
```

## Features

- Open, clone, and switch between repositories in tabs; recents and the open tabs are restored on launch
- Working tree: stage, unstage, discard, commit, amend, and commit and push
- Branches and tags: create, check out, delete (optionally on the remote), push tags
- History with a commit graph, search, multi-select, and comparing two commits or branches
- Fetch, pull (merge or rebase), push, and publish a branch; add, edit, and remove remotes
- Merge, rebase, interactive rebase, cherry-pick, revert, and reset
- Conflict resolution per hunk, with continue, skip, and abort for the running operation
- Stash save, apply, pop, drop, and a per-file stash diff
- File browser with blame and per-file history
- Create and apply patches
- Light and dark themes
