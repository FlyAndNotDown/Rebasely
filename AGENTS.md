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

Use the npm scripts in `package.json` and the committed lockfiles. Development requires Node.js 22.13+ on the 22.x line, 24.x, or 26+, stable Rust, and the platform prerequisites for Tauri. Git is required for Git operations; the Perforce CLI is required for Perforce operations.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked frontend dependencies |
| `npm run dev` | Start the Tauri desktop app with Vite |
| `npm run vite:build` | Check TypeScript and build the frontend |
| `npm run check:source` | Reject Han characters and invalid UTF-8 in repository text |
| `npm run check` | Run the source policy, TypeScript, ESLint, and Vitest |
| `npm run check:rust` | Run rustfmt, Clippy with warnings denied, and Rust tests |
| `npm run check:all` | Run both frontend and Rust checks |
| `npm run build` | Build and bundle the desktop app |

Run the checks for the code you change. For a change across the command boundary, run both suites. Documentation-only changes need content, link, and asset checks; do not add tests just to exercise prose. Report any check you could not run.

The GitHub workflow checks Windows, macOS, and Linux natively. A successful Windows check does not establish that the other platforms work; distinguish local results from pending CI results.

## Dependency selection

- A newly selected direct Rust component must have at least 500 GitHub stars on its source repository when adopted. Verify the primary repository, maintenance status, license, platform support, and API fit before adding it; a download count is not a substitute for the star requirement.
- Prefer maintained components from established projects over new platform-specific implementations. Keep operating-system integration behind `src-tauri/src/platform.rs` and executable discovery behind `locate.rs`.
- Keep lockfiles committed, use locked Rust checks, and avoid unrelated dependency upgrades. Remove unused build tools rather than retaining their dependency trees. Do not use forced major-version audit fixes without reviewing compatibility.
- Run dependency audits for security-related updates and review informational findings as well as the exit status. Track unresolved upstream constraints in `docs/security.md`; never silently suppress them.

## Architecture and command boundary

- Keep filesystem access, subprocesses, credentials, and repository operations in Rust. React calls the typed clients in `src/lib/git.ts` and `src/lib/p4.ts`.
- Route Git and Perforce operations through their existing CLI adapters and selected executables. Git hooks, clean/smudge filters, signing, LFS, and repository configuration must continue to work as they do from the command line.
- When changing a command, update its Rust handler and registration, serialized models, TypeScript types, and client call together. Preserve the existing camelCase JSON fields, optional-value conventions, event payloads, and shared error/cancellation strings.
- Send blocking process and disk work through the existing `blocking` / `with_repo_async` helpers. Preserve deliberately ordered persistence, including synchronous session saves; moving it to independent background tasks can reorder writes.
- Use the existing persistence helpers and defaulted fields when extending preferences or sessions so older saved data remains readable.
- Create background subprocesses through `platform::background_command` so cancellation can stop their process group and Windows does not flash console windows. Interactive terminals follow their own native launch rules. Native opening and revealing go through the platform module; never enable generic shell IPC for the frontend.

## Asynchronous state and performance

- Scope activities, progress, refreshes, and in-flight requests to the repository or tab that started them. Independent repositories must be able to work concurrently.
- Preserve generation and history-epoch guards after asynchronous calls. A stale result must not restore an old file selection, overwrite another repository's state, or mark invalidated history as loaded.
- Apply mutation results to their original session even if the user switches tabs. Keep refresh coalescing, watcher hints, and mutation ordering intact.
- Keep background fetches non-interactive. User-started credential prompts use the existing askpass flow and must finish or be released when the owning activity ends.
- Preserve bounded diffs, paged/streamed history, lazy loading, and virtualized rows. Avoid loading an entire repository or rerendering every pane for progress updates.
- Bound credential messages, concurrent credential connections, diagnostic tails, and image reads before allocation. Preserve streaming command output semantics rather than arbitrarily truncating repository data.

## Paths, processes, and repository safety

- Pass subprocess arguments separately through the existing command helpers. Do not build shell commands from repository paths, refs, remote URLs, or other user input.
- Validate repository-relative paths with the existing safety helpers before joining them to a root. Account for Windows verbatim paths, drive letters, separators, spaces, case behavior, and linked worktrees; do not assume `.git` is a directory.
- Keep Git path parsing NUL-delimited where supported. Preserve file bytes and missing-newline behavior when building or applying patches.
- Keep Perforce depot paths, client paths, and local paths distinct. Preserve filespec escaping and explicit connection flags so inherited environment settings cannot redirect a command.
- Cancellation must stop the owning process and its helpers. Cleanup must remain limited to resources created by that operation, including lock files and incomplete clones.
- Preserve the application's existing confirmations and recovery behavior for discard, reset, rebase, force push, and workspace mutations.
- Respect filesystem case sensitivity: only Windows lookup keys may fold case. Validate Unix execute permissions when selecting tools, and classify a missing Git or Perforce executable distinctly from a failed repository operation.
- Use Git's built-in diff and merge adapters where supported. Any unavoidable shell command stored in Git configuration must quote literal executable paths for Git's shell, including quotes, dollar signs, backticks, and spaces.

## UI and code conventions

- Keep TypeScript strict and React Hooks lint rules enabled. Extract pure helpers into `src/lib/` or `src/state/` instead of growing components or suppressing diagnostics.
- Reuse the Radix/shadcn primitives in `src/components/ui/`, Lucide icons, and theme tokens in `src/index.css`. Maintain light and dark themes, keyboard navigation, visible focus, and accessible names for icon buttons.
- Keep all repository code, comments, fixtures, and user-facing copy in English, with no Han characters. `npm run check:source` enforces the text policy.
- Include loading, empty, error, and cancellation states when adding an asynchronous interaction. Missing optional tools must leave Settings accessible, explain which executable is needed, and offer a recovery action.
- Use `useGitPick` or `useGitSelect` to subscribe to the state a component needs. Keep expensive parsing and row preparation out of render paths.
- Follow the neighboring code's organization. Format Rust with rustfmt, keep repository text on LF, and avoid unrelated dependency, formatting, or generated-file churn.

## Shared interaction and design rules

- Use the shared `Button`, dialog, menu, field, tooltip, and scroll primitives. Use semantic theme tokens for surfaces, borders, text, selection, and destructive actions; support light and dark themes without hard-coded palette substitutes.
- Keep pane headers, separators, spacing, control sizes, and action placement consistent across Git and Perforce. Use the primary button variant for the main action, outline/ghost for secondary actions, and destructive styling for irreversible changes. A dialog's primary action belongs with its footer actions; label actions with their concrete effect and scope.
- Buttons default to `type="button"`. Form submission requires an explicit `type="submit"`. Give icon-only controls accessible names, keep visible keyboard focus, and avoid nesting interactive controls.
- Disable duplicate mutations while busy, preserve entered values after a failure, and show progress or a busy label. Destructive actions retain a confirmation that names the affected scope. Do not replace a recoverable error with an indefinite skeleton.
- Show a useful empty state and a clear next action. Use `role="status"` for loading and `role="alert"` for errors. Persistent dependency and settings failures need an inline explanation and recovery action; reserve toasts for brief operation feedback.
- Use Command on macOS and Control on Windows/Linux through the shared shortcut helpers and formatter. Ignore unrelated modifier combinations and protect text editing from workspace shortcuts.
- Keep asynchronous settings resources independent. Retry results must not overwrite newer edits or restore a stale executable selection. Availability alerts retain their state even before a subscriber mounts.
- Load workspace features on demand behind a stable loading state. Reuse the shared row virtualizer for large lists and diffs, preserving row height, horizontal scroll width, selection, and inactive-pane state. Both version-control views use 20-pixel code rows and four-column tab stops unless wrapped-row measurement explicitly accounts for height changes.
- Respect `prefers-reduced-motion` for nonessential animation and retain clear feedback when motion is reduced.
- Keep Radix state aliases in the project's CSS. Do not depend on a component-generator CLI solely to obtain runtime styles.

## Tests

- Frontend tests use Vitest and live beside their pure helpers as `*.test.ts`. Rust tests cover CLI parsing and observable repository behavior, with Git integration coverage in `src-tauri/src/git/tests.rs`.
- Add regression coverage for behavior changes, especially stale asynchronous results, path handling, command arguments, parsing, and destructive operations. Test the behavior at the appropriate boundary rather than duplicating the implementation.
- Create isolated temporary repositories and use local test identities. Tests must not rely on a live Perforce server, a developer's repositories, global Git configuration, credentials, or installed editor preferences.
- Give parallel tests unique temporary paths and restrict cleanup to those paths. Preserve platform guards and keep fixtures useful across supported operating systems.
- SSH askpass integration tests need the application executable as a helper. Build it with `cargo build --manifest-path src-tauri/Cargo.toml --locked --bin rebasely` before running those tests; the GitHub check workflow does this. Report a skipped integration prerequisite explicitly.

## Privacy and fixtures

Inspecting a live Git or Perforce workspace while debugging is allowed. Copying its details into the repository is forbidden.

- Source, tests, comments, documentation, screenshots, artwork, and commit messages must not contain real people, company or client names, private hosts, emails, depot or stream names, server addresses, ports, changelist numbers, credentials, fingerprints, or machine paths taken from a live environment.
- Invent fixtures such as `alice@dev-pc`, `alice@example.com`, `ssl:perforce.example.com:1666`, `//depot/main/file.txt`, `C:\work\client\file.txt`, and changelist `42`.
- Public dependency names, documented protocol defaults, portable system lookup paths, and required loopback endpoints may remain when they describe actual application behavior.
- The existing About dialog author is the only personal identity that belongs in the source tree. Git author and committer metadata use the configured repository identity.
- Keep diagnostic dumps and backups outside the repository. Review staged files and commit messages for live-environment details before publishing.
- Keep editor workspace configuration such as `.vscode/` untracked. Do not add allowlist exceptions for editor recommendations or local settings.
- Never accept a new or changed Perforce TLS fingerprint automatically. Ask users to verify and establish trust using the CLI, then retry. Redact embedded URL credentials and sensitive query parameters before serializing backend errors.
- Use operating-system randomness for credential tokens and finite credential request lifetimes. Publish private keys without overwriting existing files, restrict permissions before publication, and never echo passphrases in failures.

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
