# Working on Rebasely

Rebasely is a desktop client for Git and Perforce, built with React, TypeScript, Tauri 2, and Rust. Changes should preserve the behavior of the underlying command-line tools and keep large repositories responsive.

## Project map

| Path | Responsibility |
| --- | --- |
| `src/components/` | Application panes, dialogs, and shared UI primitives |
| `src/components/p4/` | Perforce workspace interface |
| `src/state/` | Repository sessions, asynchronous actions, refreshes, and selection |
| `src/lib/` | Typed command clients and reusable, testable UI logic |
| `src/types/` | TypeScript models for the Rust command boundary |
| `src-tauri/src/lib.rs` | Tauri commands, event wiring, and blocking-work dispatch |
| `src-tauri/src/git/` | Git commands, parsers, history, diffs, and operations |
| `src-tauri/src/p4/` | Perforce executable selection, parsing, and workspace operations |
| `src-tauri/src/` | Credentials, executable discovery, persistence, file watching, and native integration |

## Development and checks

Use the npm scripts in `package.json` and the committed lockfiles. Development requires Node.js 22.13+ on the 22.x line or Node.js 24+, stable Rust, and the platform prerequisites for Tauri. Git is required for Git operations; the Perforce CLI is required for Perforce operations.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked frontend dependencies |
| `npm run dev` | Start the Tauri desktop app with Vite |
| `npm run vite:build` | Check TypeScript and build the frontend |
| `npm run check` | Run TypeScript, ESLint, and Vitest |
| `npm run check:rust` | Run rustfmt, Clippy with warnings denied, and Rust tests |
| `npm run check:all` | Run both frontend and Rust checks |
| `npm run build` | Build and bundle the desktop app |

Run the checks for the code you change. For a change across the command boundary, run both suites. Documentation-only changes need content, link, and asset checks; do not add tests just to exercise prose. Report any check you could not run.

## Architecture and command boundary

- Keep filesystem access, subprocesses, credentials, and repository operations in Rust. React calls the typed clients in `src/lib/git.ts` and `src/lib/p4.ts`.
- Route Git and Perforce operations through their existing CLI adapters and selected executables. Git hooks, clean/smudge filters, signing, LFS, and repository configuration must continue to work as they do from the command line.
- When changing a command, update its Rust handler and registration, serialized models, TypeScript types, and client call together. Preserve the existing camelCase JSON fields, optional-value conventions, event payloads, and shared error/cancellation strings.
- Send blocking process and disk work through the existing `blocking` / `with_repo_async` helpers. Preserve deliberately ordered persistence, including synchronous session saves; moving it to independent background tasks can reorder writes.
- Use the existing persistence helpers and defaulted fields when extending preferences or sessions so older saved data remains readable.

## Asynchronous state and performance

- Scope activities, progress, refreshes, and in-flight requests to the repository or tab that started them. Independent repositories must be able to work concurrently.
- Preserve generation and history-epoch guards after asynchronous calls. A stale result must not restore an old file selection, overwrite another repository's state, or mark invalidated history as loaded.
- Apply mutation results to their original session even if the user switches tabs. Keep refresh coalescing, watcher hints, and mutation ordering intact.
- Keep background fetches non-interactive. User-started credential prompts use the existing askpass flow and must finish or be released when the owning activity ends.
- Preserve bounded diffs, paged/streamed history, lazy loading, and virtualized rows. Avoid loading an entire repository or rerendering every pane for progress updates.

## Paths, processes, and repository safety

- Pass subprocess arguments separately through the existing command helpers. Do not build shell commands from repository paths, refs, remote URLs, or other user input.
- Validate repository-relative paths with the existing safety helpers before joining them to a root. Account for Windows verbatim paths, drive letters, separators, spaces, case behavior, and linked worktrees; do not assume `.git` is a directory.
- Keep Git path parsing NUL-delimited where supported. Preserve file bytes and missing-newline behavior when building or applying patches.
- Keep Perforce depot paths, client paths, and local paths distinct. Preserve filespec escaping and explicit connection flags so inherited environment settings cannot redirect a command.
- Cancellation must stop the owning process and its helpers. Cleanup must remain limited to resources created by that operation, including lock files and incomplete clones.
- Preserve the application's existing confirmations and recovery behavior for discard, reset, rebase, force push, and workspace mutations.

## UI and code conventions

- Keep TypeScript strict and React Hooks lint rules enabled. Extract pure helpers into `src/lib/` or `src/state/` instead of growing components or suppressing diagnostics.
- Reuse the Radix/shadcn primitives in `src/components/ui/`, Lucide icons, and theme tokens in `src/index.css`. Maintain light and dark themes, keyboard navigation, visible focus, and accessible names for icon buttons.
- Keep user-facing copy in English. Include loading, empty, error, and cancellation states when adding an asynchronous interaction.
- Use `useGitPick` or `useGitSelect` to subscribe to the state a component needs. Keep expensive parsing and row preparation out of render paths.
- Follow the neighboring code's organization. Format Rust with rustfmt, keep repository text on LF, and avoid unrelated dependency, formatting, or generated-file churn.

## Tests

- Frontend tests use Vitest and live beside their pure helpers as `*.test.ts`. Rust tests cover CLI parsing and observable repository behavior, with Git integration coverage in `src-tauri/src/git/tests.rs`.
- Add regression coverage for behavior changes, especially stale asynchronous results, path handling, command arguments, parsing, and destructive operations. Test the behavior at the appropriate boundary rather than duplicating the implementation.
- Create isolated temporary repositories and use local test identities. Tests must not rely on a live Perforce server, a developer's repositories, global Git configuration, credentials, or installed editor preferences.
- Give parallel tests unique temporary paths and restrict cleanup to those paths. Preserve platform guards and keep fixtures useful across supported operating systems.

## Privacy and fixtures

Inspecting a live Git or Perforce workspace while debugging is allowed. Copying its details into the repository is forbidden.

- Source, tests, comments, documentation, screenshots, artwork, and commit messages must not contain real people, company or client names, private hosts, emails, depot or stream names, server addresses, ports, changelist numbers, credentials, fingerprints, or machine paths taken from a live environment.
- Invent fixtures such as `alice@dev-pc`, `alice@example.com`, `ssl:perforce.example.com:1666`, `//depot/main/file.txt`, `C:\work\client\file.txt`, and changelist `42`.
- Public dependency names, documented protocol defaults, portable system lookup paths, and required loopback endpoints may remain when they describe actual application behavior.
- The existing About dialog author is the only personal identity that belongs in the source tree. Git author and committer metadata use the configured repository identity.
- Keep diagnostic dumps and backups outside the repository. Review staged files and commit messages for live-environment details before publishing.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit:

```text
type(scope): subject
```

- Types: `feat`, `fix`, `perf`, `refactor`, `style`, `test`, `docs`, `build`, `ci`, `chore`.
- Use a specific lowercase scope such as `git`, `p4`, `history`, `diff`, `ui`, or `docs`.
- Write an imperative, lowercase subject without a final period; aim for 72 characters or fewer.
- Keep one concern per commit. Explain the reason or behavior change in the body when needed, with a blank line after the subject.
- Do not append co-author, assistant, or AI attribution trailers or signatures.
- Preserve unrelated working-tree changes and stage only the files that belong to the task. Verify the staged diff before committing.
