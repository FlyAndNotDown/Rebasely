# Desktop test automation

This is a feasibility assessment, reviewed on 2026-10-31. No driver, test plugin,
service, or additional CI job is installed by this proposal.
Linux entries below describe CI test builds; Linux desktop packages are paused.

## Driver support

| Route | Windows | Linux | macOS | Application changes |
| --- | --- | --- | --- | --- |
| Direct `tauri-driver` | Supported | Supported | Unsupported | No embedded test plugin |
| WebdriverIO embedded provider | Supported | Supported | Supported | Test-only Rust plugin and capabilities |
| Browser tests against Vite | Renderer only | Renderer only | Renderer only | Native commands require mocks |

The current [Tauri WebDriver guide](https://v2.tauri.app/develop/tests/webdriver/)
documents macOS support through WebdriverIO's embedded provider. The narrower
limitation is that direct `tauri-driver` has no macOS WKWebView driver. It would
be inaccurate to describe all Tauri end-to-end testing as unavailable on macOS.

The embedded route needs `tauri-plugin-wdio-webdriver`; richer API access and
mocking use `tauri-plugin-wdio`. These components live in
[webdriverio/desktop-mobile](https://github.com/webdriverio/desktop-mobile),
an active MIT project with 20 stars when reviewed. That source repository does
not meet this project's requirement of 500 stars for a new direct Rust
component. Documentation by an established project does not waive that rule.
Recheck eligibility before adoption. The
[plugin setup guide](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)
also requires test instrumentation to be excluded from production builds.

## Smallest useful next step

Start with one Linux application smoke test using the real frontend, Rust
commands, and Git CLI. Use direct `tauri-driver`, one standard Node WebDriver
client, and the existing test runner. A client such as
[Selenium's JavaScript library](https://www.selenium.dev/documentation/webdriver/getting_started/install_library/)
avoids adding another full test framework. Pin and review the selected tools
when implementing; do not build a custom WebDriver protocol layer.

Linux needs `WebKitWebDriver` and a display. Tauri's
[CI example](https://v2.tauri.app/develop/tests/webdriver/ci/) uses
`webkit2gtk-driver` and Xvfb. Extend to Windows after that flow is stable;
[Microsoft requires Edge WebDriver to match the WebView2 runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver).
An unrelated installed Edge version is insufficient evidence of compatibility.

Add any future smoke steps to the existing pull-request Check workflow. Preserve
its `master` target, existing event restrictions, and checked-source notices.
Keep test artifacts separate from desktop release packages. No desktop release
or new push-triggered workflow is needed to run these checks.

## Disposable fixtures

- **Git:** create a unique temporary folder with invented files and an isolated
  Git configuration containing a test identity. Enter its absolute path through
  Initialize Git repository, then verify initialization, stage, commit, history,
  and repository switching through the application and independent Git commands.
  Use a disposable bare origin for later remote scenarios. Open local and the
  clone-location chooser still use native dialogs; the clone Location field is
  read only. A WebView driver cannot type into that system chooser, so keep
  file-picker coverage native instead of adding a privileged testing command.
- **Perforce:** add one Linux smoke case with pinned official `p4` and `p4d`
  binaries. Start `p4d` as a child process with a fresh server root and a dedicated
  loopback port; create an invented user, depot, and workspace. Perforce documents
  the [`-r` root and `-p` listener arguments](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/tutorial.start-server.html).
  Connect through the normal form, then check pending files, diff, shelf, and
  submit against CLI results. A local Docker installation, persistent server,
  mounted developer directory, or external account is unnecessary.
- **Lifetime:** use a fresh hosted runner profile, with fixtures, logs, and
  screenshots in a unique runner-temporary directory. Establish application
  profile isolation before any optional local run; the current application
  does not expose a test-profile switch. Do not overwrite a developer's
  preferences. Use bounded
  readiness waits, stop only owned processes in `finally`, and remove only
  directories created by that test. Keep service tests separate from unit tests.

Prefer accessible names and stable user-visible states to coordinates or fixed
sleeps. Capture a screenshot and bounded diagnostic tail on failure. Never use
live workspaces, remote credentials, or committed environment dumps as fixtures.

## Coverage that remains native

Keep the current Rust and frontend checks on all supported operating systems.
Retain manual macOS acceptance until an eligible automation route is selected
and demonstrated. Browser tests and successful DOM assertions do not establish
correct native window rendering.

The native acceptance pass should cover cold launch, keyboard focus, repository
tabs, repeated command-palette and Settings open/close cycles, light/dark themes,
maximize/restore, restart with saved bounds, and footer visibility. Inspect an
optimized application bundle as well as the development build. Desktop chrome,
system dialogs, painting, installation, and updater behavior still need their
own native evidence even when WebDriver smoke tests pass.
