# Security and dependency checks

Rebasely delegates repository operations and authentication to the selected Git
and Perforce executables. Open repositories only when you trust their hooks,
filters, Git configuration, and configured external tools. The application does
not sandbox those command-line programs.

## Application boundaries

- Filesystem access and process execution remain in Rust. The webview does not
  receive a general-purpose shell or native opener capability.
- Perforce never automatically accepts a new or changed TLS fingerprint. Verify
  it independently and establish trust using the Perforce CLI.
- Credential requests use a bounded, operation-owned loopback endpoint. URL
  credentials and sensitive query values are redacted from backend errors.
  SSH key creation and copying never overwrite existing key files and restrict
  private-key permissions.
- Repository file browsing checks resolved paths against the worktree boundary.
  Image and text previews limit reads before allocating the whole file.
- Updates accept only signed packages from this repository's HTTPS GitHub
  Releases URLs, using an embedded public key and signed version verification.
- Client proxy settings affect application HTTP requests, including updates and
  optional avatar lookups. They do not change system settings or Git and
  Perforce routing. System mode supports static HTTP/HTTPS proxies on Windows
  and macOS, and proxy environment variables. PAC/WPAD and system SOCKS-only
  settings require a manual proxy URL. Manual URLs reject embedded credentials.
- Diagnostics stay on the device and record bounded operation categories,
  outcomes, and durations. Exporting a ZIP does not upload it. Built-in avatars
  stay offline; selecting GitHub or GitLab permits public-profile lookups using
  commit email addresses.

Review screenshots, exported logs, repository names, paths, and remote addresses
before sharing them. Keep live workspace evidence outside this repository.

## Dependency checks

Use the committed lockfiles and review compatibility before upgrading. Keep the
opener pin aligned with the Tauri runtime. The updater's 2.14 minor-line
constraint preserves compatibility with its reqwest HTTP builder API.

```bash
npm audit
cargo install cargo-audit --locked
cargo audit --file src-tauri/Cargo.lock
```

### Known upstream constraints

Last reviewed: 2026-10-31.

The ESLint and TypeScript ESLint development dependency chain uses
[`minimatch` 10.2.6, GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
Attacker-controlled glob patterns can amplify CPU and memory use with
`optimizationLevel >= 2`. The patched 11.0.1 release is outside the current
upstream packages' 10.x ranges. Follow a compatible upstream migration rather
than npm's suggested forced tooling downgrades.

Rust dependencies retain the following informational findings:

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
dependencies, and review informational findings even when the audit succeeds.
