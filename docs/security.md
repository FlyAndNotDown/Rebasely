# Security and dependency checks

Rebasely delegates repository operations and authentication to the selected Git
and Perforce executables. Open repositories only when you trust their hooks,
filters, Git configuration, and configured external tools. The application does
not sandbox those command-line programs.

## Application boundaries

- Filesystem access and process execution remain in Rust. The webview does not
  receive a general-purpose shell or native opener capability.
- Git and Perforce executable failures use distinct recovery errors. Settings
  remains available so the executable can be selected again.
- Perforce never automatically accepts a new or changed TLS fingerprint. Verify
  the fingerprint independently and establish trust using the Perforce CLI.
- Credential requests use an operating-system random token over loopback, with
  connection, message-size, and lifetime limits. URL credentials and sensitive
  query values are redacted from serialized errors and progress diagnostics.
- SSH key publication does not overwrite existing private or public files.
  Private-key permissions are restricted before a copied key is written or
  published. Nonempty key passphrases reach `ssh-keygen` through an
  operation-owned askpass endpoint, never through arguments, environment values,
  or temporary files. Temporary secret buffers are cleared with `zeroize`.
  Passphrases are limited to 1,023 UTF-8 bytes to match OpenSSH's askpass buffer
  without silent truncation.
- Repository file browsing checks resolved paths against the worktree boundary.
  Image and text previews limit reads before allocating the whole file.
- Application updates use the official Tauri updater with an embedded public
  key and signed version verification. Checks run once at startup and on an
  explicit request in Settings. The Update action starts download and installation;
  after installation, Restart or Later is the only restart decision. The Windows
  installer closes the application without forcing a relaunch. Background check
  failures stay quiet; Settings and user-started operations retain retry actions.
  Installation accepts only signed packages from this repository's HTTPS GitHub
  Releases URLs.
  The private signing key stays outside the repository and in an Actions secret.
- Client HTTP routing is shared by updates and optional public-profile lookups.
  System mode uses standard proxy environment variables, falling back to static
  Windows or macOS HTTP/HTTPS proxy settings. Linux uses environment variables.
  PAC/WPAD scripts and system SOCKS-only configuration are not evaluated by the
  HTTP library; manual HTTP, HTTPS, SOCKS5, and SOCKS5H URLs are supported. No proxy
  mode disables implicit routing, and manual mode uses only the selected proxy.
  Manual URLs reject credentials, query parameters, fragments, and paths before
  persistence. Validation errors never reflect their input. These preferences
  never change system settings or the Git and Perforce subprocess environment.

These controls do not make arbitrary command output safe to publish. Review
screenshots, logs, repository names, paths, and remote addresses before sharing
them. Keep live workspace evidence outside this repository.

## Dependency selection

New direct Rust components require at least 500 GitHub stars on the source
repository when adopted, alongside maintenance, license, API, and platform
review. The platform and security refactor selected components from these
repositories, each verified above that threshold when adopted:

| Component | Source repository | Use |
| --- | --- | --- |
| `tauri-plugin-opener` | [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) | Native open and reveal operations |
| `tauri-plugin-updater` | [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) | Signed application updates from GitHub Releases |
| `nix` | [nix](https://github.com/nix-rust/nix) | Safe Unix process-group cancellation |
| `tempfile` | [tempfile](https://github.com/Stebalien/tempfile) | Atomic persistence and non-overwriting key publication |
| `getrandom` | [getrandom](https://github.com/rust-random/getrandom) | Operating-system credential token randomness |
| `url` | [rust-url](https://github.com/servo/rust-url) | External link validation and query redaction |
| `regex` | [regex](https://github.com/rust-lang/regex) | Diagnostic credential redaction |
| `zeroize` | [RustCrypto utilities](https://github.com/RustCrypto/utils) | Clearing temporary secret buffers |
| `reqwest` | [reqwest](https://github.com/seanmonstar/reqwest) | Shared HTTP clients and explicit proxy routing |
| `rustls` | [rustls](https://github.com/rustls/rustls) | Initialize the existing ring TLS provider before independent HTTP requests |

The opener version is pinned to the current Tauri runtime's compatible release.
Review the pin together with future runtime upgrades.

The updater was adopted from the maintained Tauri plugins workspace (1,838
GitHub stars on 2026-10-30), under Apache-2.0 or MIT, with Windows, macOS, and
Linux support. Its signed version checks require the compatible Tauri 2.12
runtime and CLI 2.12.4; the Windows WebView dependencies are aligned with that
runtime.

The HTTP integration adopted `reqwest` (11,890 stars, MIT or Apache-2.0) and
`rustls` (7,721 stars, MIT, Apache-2.0, or ISC) on 2026-10-31. Both upstream
repositories were active and supported the application's Windows, macOS, and
Linux targets. Their versions and TLS backend were already in the lockfile;
making them direct dependencies did not update transitive package versions.
The updater is constrained to its 2.14 minor line because its HTTP builder hook
exposes the corresponding reqwest API. Routing tests use finite loopback HTTP
fixtures, invalid test signatures, and no installation or private signing keys.

## Audit commands and remaining upstream issues

```bash
npm audit
cargo install cargo-audit --locked
cargo audit --file src-tauri/Cargo.lock
```

On 2026-10-31, `npm audit` reported 11 moderate findings in the ESLint and
TypeScript ESLint development dependency chain, all tracing to
[`minimatch` 10.2.6, GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
Attacker-controlled glob patterns can amplify CPU and memory use with
`optimizationLevel >= 2`. The patched version is 11.0.1, outside the current
upstream packages' 10.x ranges; npm's suggested forced changes downgrade major
tooling versions. Follow a compatible upstream migration rather than silently
overriding the dependency. `npm audit --omit=dev` reported no findings.

The same day's Rust audit reported no entries classified as vulnerabilities by
RustSec, after updating Tokio and the yanked `yoke-derive` release. Informational
findings remain and must still be reviewed:

- [`glib` 0.18.5, RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
  has an unsound `VariantStrIter` implementation. Tauri's Linux GTK 3 dependency
  graph requires the 0.18 series; the upstream fix is in 0.20 and is not a
  compatible lockfile update. Rebasely does not directly call this iterator, but
  that does not establish that all upstream code is unaffected.
- Tauri's build dependencies include the unmaintained `proc-macro-error` crate.
- The opener's Linux D-Bus dependencies include `zbus_names`, `zvariant`, and
  `zvariant_derive`, which moved into `zbus` 6 and are no longer maintained as
  separate crates. Follow the upstream opener migration rather than overriding
  those crates to incompatible major versions.

No advisory is suppressed in project configuration. Re-run audits when updating
dependencies, and distinguish a successful audit exit code from the absence of
informational findings.
