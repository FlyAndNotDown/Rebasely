# Development

## Requirements

- Node.js 22.13+ on the 22.x line, 24.x, or 26+, with npm.
- Stable Rust, with `rustfmt` and `clippy`.
- Git; the Perforce CLI (`p4`) is needed only for Perforce workspaces.
- The [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).
  macOS builds target Apple Silicon.

```sh
npm ci
npm run dev
```

To create a local application bundle:

```sh
npm run build
```

Bundles are written to `src-tauri/target/release/bundle/`.

## Checks

```sh
rustup component add rustfmt clippy
cargo build --manifest-path src-tauri/Cargo.toml --locked --bin rebasely
npm run check:all
```

The binary build supplies the helper needed by SSH askpass integration tests.

| Command | Purpose |
| --- | --- |
| `npm run check` | Source policy, version consistency, TypeScript, ESLint, and frontend tests |
| `npm run check:rust` | rustfmt, Clippy, and Rust tests with the committed lockfile |
| `npm run check:site` | Website typecheck, production build, and asset validation |
| `npm run vite:build` | Frontend production build |
| `npm run check:all` | Both check suites |

Run both suites for a change across the command boundary. Documentation changes
need content, link, and asset checks. State any check or platform you could not
verify. Native CI checks run on pull requests targeting `master`; a successful
check on one operating system does not establish support on the others.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/components/` | Workspace panes, dialogs, and shared UI primitives |
| `src/i18n/` | Application language selection and UI resources |
| `src/components/ui/` | Shared controls |
| `src/components/p4/` | Perforce workspace interface |
| `src/state/` | Repository sessions, async actions, refreshes, and selection |
| `src/lib/` | Typed command clients and reusable UI logic |
| `src/types/` | Frontend command models |
| `src-tauri/src/` | Native operations, persistence, credentials, and platform integration |
| `src-tauri/src/git/`, `src-tauri/src/p4/` | CLI adapters and repository operations |
| `src-tauri/icons/` | Application icon source and desktop assets |
| `scripts/` | Source checks and release tooling |
| `site/` | GitHub Pages website source and brand artwork |
| `docs/` | Development guide |

Frontend files use kebab-case, with React entry points `App.tsx` and `main.tsx`.
Rust modules use snake_case. Tests live beside pure frontend helpers or with
the Rust module they cover. Keep generated output and local service
configuration outside version control.

Repository operations run through the selected command-line executables. Rust
owns filesystem and process access; React uses typed clients. Preserve command
behavior, async ownership, cancellation, and bounded loading. The complete
engineering rules are in [AGENTS.md](../AGENTS.md).

## Website

The website uses React and Vite with the same dependencies, UI primitives,
Geist fonts, and theme tokens as the desktop app. It does not call native
commands.

```sh
npm run site:dev
npm run check:site
npm run site:preview
```

`check:site` typechecks, builds, and checks the website assets. Vite writes
`site/dist/`.

## Localization

The app and website use i18next and react-i18next with English fallback.
Keep translated text in `src/i18n/locales/` for the application and
`site/src/locales/` for the website. Reuse existing keys and interpolation for
dynamic values; keep code, repository fixtures, and developer comments in English.

The website prerenders a language-neutral entry page and separate `/en/` and
`/zh-CN/` pages. Language pages must work without JavaScript and include matching
canonical, alternate-language, and structured metadata. Browser preferences only
select the initial homepage language; explicit locale links stay stable.
