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
npm run check       # typecheck, lint, and frontend tests
npm run check:rust  # rustfmt, clippy, and the Rust tests
npm run check:all   # both
```


## Build

```bash
npm run build
```

## Features

- Open, clone, and switch between repositories in tabs; recents and the open tabs are restored on launch
- Working tree: stage, unstage, and discard whole files, hunks, or single lines; commit, amend, commit and push, and undo the last commit
- Changed files as a list or a folder tree, with multi-select, keyboard control, stashing selected files, and adding to .gitignore
- Writes go through git itself, so Git LFS, hooks, commit and tag signing, and sparse checkout behave as on the command line
- Diffs inline or side by side, with syntax highlighting, hidden whitespace, and image diffs (side by side, swipe, onion skin)
- Branches and tags: create, check out, delete (optionally on the remote), push tags, and delete them from remotes
- History with a commit graph, multi-select, comparing two commits or branches, and search by author, path, content, or date
- Reflog to recover earlier states
- Fetch, pull (merge or rebase), push, and publish a branch, with cancel, credential prompts, background fetching, and pruning
- Merge, rebase, interactive rebase, cherry-pick, revert, and reset; continue from the commit box with an edited message
- Conflict resolution per hunk or in the configured merge tool
- Stash save, apply, pop, drop, and a per-file stash diff
- File browser with blame and per-file history
- Submodules and worktrees
- Open files in an editor, and diffs in the configured diff tool
- Command palette (Ctrl+K) and keyboard shortcuts
- Create and apply patches
- Light and dark themes
