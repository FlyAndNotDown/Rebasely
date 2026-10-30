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

These controls do not make arbitrary command output safe to publish. Review
screenshots, logs, repository names, paths, and remote addresses before sharing
them. Keep live workspace evidence outside this repository.

## Dependency selection

New direct Rust components require at least 500 GitHub stars on the source
repository when adopted, alongside maintenance, license, API, and platform
review. The platform and security refactor selected components from these
repositories, each verified above that threshold on 2026-10-30:

| Component | Source repository | Use |
| --- | --- | --- |
| `tauri-plugin-opener` | [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) | Native open and reveal operations |
| `nix` | [nix](https://github.com/nix-rust/nix) | Safe Unix process-group cancellation |
| `tempfile` | [tempfile](https://github.com/Stebalien/tempfile) | Atomic persistence and non-overwriting key publication |
| `getrandom` | [getrandom](https://github.com/rust-random/getrandom) | Operating-system credential token randomness |
| `url` | [rust-url](https://github.com/servo/rust-url) | External link validation and query redaction |
| `regex` | [regex](https://github.com/rust-lang/regex) | Diagnostic credential redaction |
| `zeroize` | [RustCrypto utilities](https://github.com/RustCrypto/utils) | Clearing temporary secret buffers |

The opener version is pinned to the current Tauri runtime's compatible release.
Review the pin together with future runtime upgrades.

## Audit commands and remaining upstream issues

```bash
npm audit
cargo install cargo-audit --locked
cargo audit --file src-tauri/Cargo.lock
```

On 2026-10-30, npm reported no known vulnerabilities. The Rust lockfile has no
entries classified as vulnerabilities by RustSec, after updating Tokio and the
yanked `yoke-derive` release. Informational findings remain and must still be
reviewed:

- [`glib` 0.18.5, RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
  has an unsound `VariantStrIter` implementation. Tauri's Linux GTK 3 dependency
  graph requires the 0.18 series; the upstream fix is in 0.20 and is not a
  compatible lockfile update. Rebasely does not directly call this iterator, but
  that does not establish that all upstream code is unaffected.
- Tauri's build and Linux desktop dependencies include the unmaintained
  `proc-macro-error` and `unic-*` crates.
- The opener's Linux D-Bus dependencies include `zbus_names`, `zvariant`, and
  `zvariant_derive`, which moved into `zbus` 6 and are no longer maintained as
  separate crates. Follow the upstream opener migration rather than overriding
  those crates to incompatible major versions.

No advisory is suppressed in project configuration. Re-run audits when updating
dependencies, and distinguish a successful audit exit code from the absence of
informational findings.
