# Working on Rebasely

Rebasely is a React, TypeScript, Tauri 2, and Rust client for Git and Perforce.
Preserve the behavior of the underlying command-line tools and keep large
repositories responsive. Read neighboring code before changing a workflow.

## Project map

| Path | Responsibility |
| --- | --- |
| `src/components/` | Git panes, dialogs, shared UI, and `p4/` views |
| `src/state/` | Sessions, asynchronous actions, refreshes, and selection |
| `src/lib/`, `src/types/` | Typed clients, pure helpers, and command models |
| `src/i18n/` | Application localization and language resources |
| `src-tauri/src/lib.rs` | Commands, events, and blocking dispatch |
| `src-tauri/src/git/`, `src-tauri/src/p4/` | CLI adapters and VCS operations |
| `src-tauri/src/` | Native integration, credentials, persistence, and watchers |
| `site/` | GitHub Pages website and browser-local demonstrations |
| `docs/` | Contributor development documentation |

## Build and check

Use the committed npm and Cargo lockfiles. Requirements and commands are in
[docs/development.md](docs/development.md).

- Frontend: `npm run check` and `npm run vite:build`.
- Rust: `npm run check:rust`; build the application helper first with
  `cargo build --manifest-path src-tauri/Cargo.toml --locked --bin rebasely`.
- Command-boundary changes need both suites. Run focused regression tests for
  changed behavior. Documentation changes need content, link, and asset checks.
- Report unavailable checks and distinguish local results from other platforms.
- Keep Check restricted to pull requests targeting `master`. Preserve native
  checked-source notices; do not add push, schedule, or manual triggers.
- Avoid unrelated dependency upgrades. Review security audit findings, report
  unresolved upstream constraints, and never hide findings or force major fixes.

## Native boundary and repository safety

- Filesystem access, subprocesses, credentials, and repository operations belong
  in Rust. React uses the typed Git and Perforce clients.
- Update handlers, command registration, serialized models, TypeScript types,
  and client calls together. Preserve camelCase fields and shared error strings.
- Dispatch blocking work through existing helpers. Preserve synchronous session
  saves and ordered persistence; default new persisted fields for compatibility.
- Use selected CLI executables and existing adapters. Preserve Git hooks,
  filters, signing, LFS, and repository configuration.
- Use `platform::background_command` for background processes and the platform
  module for native opening/revealing. Cancellation must stop process helpers.
- Pass arguments separately. Validate relative paths before joining a root;
  support Windows verbatim paths, drive letters, spaces, and linked worktrees.
- Keep Git paths NUL-delimited where supported; preserve bytes and final
  newlines. Distinguish Perforce depot, client, and local paths and escape filespecs.
- Retain explicit Perforce connection flags. Never accept TLS fingerprints
  automatically; ask the user to establish verified trust through the CLI.
- Preserve confirmations and recovery for destructive operations. Cleanup is
  limited to resources created by the owning operation.
- Fold lookup keys only on Windows, verify Unix execute permissions, and
  distinguish a missing executable from a failed repository operation.

## State, performance, and interface

- Scope activities, requests, and refreshes to the originating repository.
  Keep generation/history guards after asynchronous calls. Apply mutations to
  their original sessions even when the user switches tabs.
- Preserve refresh coalescing, watcher hints, and mutation ordering. Background
  fetches stay non-interactive; release prompts when their activity ends.
- Keep diffs bounded, history paged/streamed, views lazy, and rows virtualized.
  Bound image reads, credential traffic, and diagnostic tails before allocation.
- Use `useGitPick` or `useGitSelect` for narrow subscriptions. Extract expensive
  parsing and testable logic from components.
- Reuse shared Radix/shadcn primitives, Lucide icons, and semantic theme tokens.
  Support light/dark themes, visible focus, keyboard access, and reduced motion.
- Buttons default to `type="button"`; forms explicitly use `type="submit"`.
  Give icon buttons accessible names and never nest interactive controls.
- Provide loading, empty, error, and cancellation states. Disable duplicate
  mutations, retain input after failure, and give recoverable errors an action.
- Keep Settings accessible when optional tools are missing. Settings resources
  load independently; retries must not overwrite newer edits or selections.
- Use platform shortcut helpers. Protect text editing from workspace shortcuts.
  Preserve 20-pixel code rows, four-column tabs, and inactive-pane state.
- Keep TypeScript strict, Hooks linting enabled, Radix state aliases intact,
  Rust formatted, and repository text on LF.

## Localization, tests, and privacy

- Keep code, comments, fixtures, and development documentation in English.
  Put translated UI text in the designated locale JSON resources. Localized
  README files are allowed. Preserve English fallback and resource key parity.
- Test behavior at the appropriate boundary: pure helpers beside their code,
  Rust CLI/parser coverage, and Git integration tests in `git/tests.rs`.
- Use isolated temporary repositories, local test identities, and unique paths.
  Tests must not depend on live servers, credentials, global Git settings,
  developer repositories, or installed editor preferences.
- Never copy live environment details into source, tests, artwork, screenshots,
  documentation, or commit messages. Use invented fixtures and keep diagnostics
  and backups outside the repository. Keep editor workspace settings untracked.
- Redact credentials and sensitive URL parameters from errors. Use OS randomness
  and finite lifetimes for credential tokens, and restrict private-key permissions
  before publication without overwriting existing keys.
- Keep public documentation useful to users and contributors. Do not add local
  setup notes, service credentials, investigation logs, or task reports.

## Git changes

Work on `dev` or a topic branch based on `dev`. Preserve unrelated changes and
stage only task files. Inspect staged diffs for correctness and private data.
Do not push to `master`, create a pull request, or publish a release unless the
user explicitly authorizes that action.

Use Conventional Commits: `type(scope): imperative lowercase subject`, without
a final period. Keep each commit focused and omit assistant attribution trailers.
External contributors follow [CONTRIBUTING.md](CONTRIBUTING.md).
