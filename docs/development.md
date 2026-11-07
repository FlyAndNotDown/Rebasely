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
cargo build --manifest-path src-tauri/Cargo.toml --locked --bin rebaseraven
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
behavior, async ownership, cancellation, and bounded loading.

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

### Analytics

Use separate GA4 properties and deployment variables for each surface:

| Surface | Property | GitHub variable | Vite variable |
| --- | --- | --- | --- |
| Desktop | RebaseRavenApp | GA_APP_MEASUREMENT_ID | VITE_GA_APP_MEASUREMENT_ID |
| Website | RebaseRavenWebsite | GA_WEBSITE_MEASUREMENT_ID | VITE_GA_WEBSITE_MEASUREMENT_ID |

GA4 offers Web, Android and iOS data streams, but no native desktop stream.
The desktop uses the isolated HTTPS bridge and the Google tag, with automatic
page views and Enhanced Measurement disabled. A validated handshake is required
before the bridge loads any remote tag. The installation ID stays independent
of website cookies and contains no machine or account identity.

Desktop events are `app_open`, `screen_view`, `app_foreground`, `app_background`
and `app_engagement`. The internal `pane_view` message becomes a Google-tag
`screen_view` event with fixed screen names. Register `pane`, `app_platform`,
`app_version` and `version_control` as event dimensions, and
`foreground_time_sec` as an event metric in seconds. Foreground time uses the
application's focus and visibility state; it does not measure physical input
activity. Repository names, paths, file contents and credentials are excluded.

The website tag runs only on public production locale pages. The root language
redirect, previews, embedded pages and `/analytics/` are excluded. It uses normal
web page views and acquisition information, plus `download_dialog_open`,
`file_download` and `demo_start`. Installer tracking accepts only published
RebaseRaven release assets; fallback release-page links are not downloads.
`file_download` measures a link click, not a completed installation.

Enable website Enhanced Measurement for scrolls and outbound clicks. Disable
automatic file downloads to avoid duplicating explicit installer events, and
disable form interactions, site search, videos and history-based page views.
Register `site_language`, `download_platform`, `entry_point` and `release_version`
as event dimensions, and mark `file_download` as a key event. Production builds
require two valid, different measurement IDs; local builds may omit both.

## Localization

The app and website use i18next and react-i18next with English fallback.
Keep translated text in `src/i18n/locales/` for the application and
`site/src/locales/` for the website. Reuse existing keys and interpolation for
dynamic values; keep code, repository fixtures, and developer comments in English.

The website prerenders a language-neutral entry page and separate `/en/` and
`/zh-CN/` pages. Language pages must work without JavaScript and include matching
canonical, alternate-language, and structured metadata. Browser preferences only
select the initial homepage language; explicit locale links stay stable.

## Brand assets

The approved glass icon master is `src-tauri/icons/app-icon.png`. The flat,
transparent mark is `assets/brand/raven.svg`. Run `npm run brand:generate` to
regenerate desktop icons, small-size favicon variants, website marks, and the
website and GitHub social cards. The generator preserves the glass icon at
normal sizes and uses a simplified mark for 16–24 pixel system icons.

Use `BrandMark` with the transparent SVG for website navigation and promotional
callouts. Its color follows the surrounding text in both themes. Use `AppMark`
for the glass application icon in desktop identity surfaces.

The website card is `site/public/assets/social.png` (1200 × 630). The GitHub
repository social preview is `assets/brand/github-social.png` (1280 × 640).
Both use the bundled Geist font. The PNG glass treatment is static artwork.

The approved README banner is `assets/brand/readme-banner.png`, shared by both
README translations. It is a selected composition, separate from generated
website and repository social cards.
