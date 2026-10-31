# Releasing Rebasely

Development happens on `dev` or topic branches based on `dev`. Merge reviewed changes into `master` through a pull request. Routine development never pushes directly to `master`.

The [Release workflow](../.github/workflows/release.yml) publishes only when the repository owner explicitly starts it on `master` and enters a stable version such as `v0.0.1`. A push, merge, or tag does not publish a release. The owner must also initiate any rerun; a collaborator cannot rerun an owner's release job to gain its publishing permissions.

## Before the first release

1. Store the Tauri updater signing private key in the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. If the key has a password, store that in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; an unencrypted key uses an empty or absent password secret.
2. Keep the matching updater public key in `src-tauri/tauri.conf.json`. Back up the private key securely outside the repository. Existing installations trust this key; replacing or losing it prevents them from accepting future updates.
3. Enable GitHub Actions and allow the workflow's `GITHUB_TOKEN` to write repository contents. No personal access token is needed. Keep `master` protected with reviewed pull requests and the native Check jobs.
4. Ensure the repository's releases are accessible to the intended users. Anonymous update checks cannot download private GitHub release assets. The workflow does not change repository visibility.
5. In **Settings → Pages**, select **GitHub Actions** as the publishing source. The `github-pages` environment must allow the release branch.
6. Merge a reviewed pull request containing the current Check and Release workflows after all three native Check jobs pass with their source-tree notices. The first release requires this pull request proof; an older branch-push check without the notices does not qualify. After merging, the owner explicitly dispatches Release on `master`.

The updater key is used only for Tauri update verification. Windows Authenticode certificates and Apple Developer signing/notarization credentials are separate. This workflow currently produces unsigned Windows installers and ad-hoc signed, unnotarized macOS packages, so first-time downloads can show operating-system security prompts.

## Publish a version

1. Finish the changes on `dev`, run the local checks, and open a pull request targeting `master`.
2. Wait for that pull request's latest **Check** workflow to succeed on Windows, macOS, and Linux, then merge the reviewed pull request. Keep its tested merge content current with `master` before merging.
3. As the repository owner, open **Actions → Release → Run workflow**, select `master`, and enter the complete version, including `v`.

The equivalent owner-only CLI request is:

```bash
gh workflow run release.yml --ref master -f version=v0.0.1
```

Use strict `vX.Y.Z` versions without leading zeros, prerelease suffixes, or build metadata. The first release can equal the checked-in source version, initially `v0.0.1`. Later versions must exceed every existing stable version tag and release, including reserved drafts, and cannot be lower than the source version. Each numeric component is limited to 65535 so Windows installers can represent it.

The Check workflow runs only when a pull request targeting `master` is opened, updated, or reopened. Ordinary branch pushes do not start it. Pushing changes to an open pull request reruns checks through the pull request's `synchronize` event. There is no separate Check run after merging.

The release workflow checks the owner's identity, including the actor who initiates a rerun, the selected branch, the version, existing tags/releases, and the merged pull request's native checks. It then creates a draft and stamps the requested version into each isolated build checkout:

- `package.json`
- `package-lock.json`, including its root package entry
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`, for the application package only
- `src-tauri/tauri.conf.json`

Dependency versions remain locked. Stamping does not commit changes or push to `dev` or `master`. The release tag identifies the reviewed source commit; the explicit workflow input determines the version embedded in its bundles. Before publishing, the workflow checks again that `master` still points to that revision and that the merged pull request's native checks prove its exact contents.

Each successful native Check job verifies that tracked source files remain unchanged, then records the checkout's Git tree hash in a `Rebasely checked source` notice. The release workflow finds the merged pull request that introduced the current `master` commit, locates its latest Check run by the pull request's final head commit, and requires all three successful jobs to carry one matching tree notice each. This proves that the complete published source matches the tested source even when a merge, squash, or rebase changes commit hashes. It also rejects a merge whose contents changed after the pull request was tested. The proof uses check annotations, with no extra validation build or uploaded artifact archive.

Ordinary local `npm run build` uses `createUpdaterArtifacts: false` and does not require the private updater key. Every release matrix entry explicitly overrides this setting to `true`, so release builds require the signing secret and generate signed updater packages. The macOS release entry also applies ad-hoc signing without changing the normal local packaging settings.

## Release assets and updates

| Platform | Installer | Signed updater package |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | The same `.exe`, with `.sig` |
| macOS Apple Silicon | `.dmg` | `.app.tar.gz`, with `.sig` |

Asset names include the full version and platform, for example `Rebasely_v0.0.1_windows_x64.exe`. Windows and macOS Apple Silicon build on native runners. Linux packages are not currently published; packages in earlier releases remain available. The source and native Check workflow retain Linux compatibility checks.

Both builds upload to the same draft. Only after every build succeeds does the final job check that every required bundle, installer, and signature exists and has finished uploading. It creates one `latest.json` containing exactly `windows-x86_64` and `darwin-aarch64`, then publishes the release and marks it latest. Generating this manifest once avoids parallel build jobs overwriting each other's platform entries.

GitHub can give draft assets temporary `untagged-...` download URLs. The final job checks these against the draft's release page and writes the requested version's permanent download URLs into `latest.json` before publishing.

The app downloads update metadata and packages over HTTPS and verifies each update using its embedded Tauri public key. Before publication, the release workflow verifies each signature's authenticated version comment against that key and the requested version. The app also verifies the downloaded artifact bytes before installation and rejects a mismatched signed version. Startup and manual update checks follow the app's update settings.

## Website deployment

The website source lives in `site/` and shares the application's React components and theme tokens. `npm run check:site` typechecks the website, builds `site/dist/`, and validates its generated assets and links. A successful release calls the [Website workflow](../.github/workflows/pages.yml) to deploy that same source revision to GitHub Pages. The website uses the repository's locked frontend dependencies; no hosting credentials are needed.

The repository owner can also run **Actions → Website → Run workflow** to publish a website correction independently of an application release. This workflow does not run the Check or Release workflows. Its manual entry point becomes available after the workflow is merged into the default branch.

A failed website deployment does not unpublish a successful application release. Fix the website or Pages settings, then rerun the Website workflow as the owner.

## Failures and retries

A failed build or validation leaves the release as a draft. It does not replace the last published updater manifest. Inspect the failed job and rerun failed jobs as the owner while `master` still points to the original source revision.

Release validation rejects missing source-tree notices, a newer failed or unfinished Check run, direct changes to `master`, and a mismatch between tested and merged contents. Ensure an up-to-date pull request passes its native checks before merging; if the merged content lacks that proof, validate a new pull request against current `master` before releasing.

A new full workflow run rejects an existing version tag or draft. To restart a completely failed release using the same version, first inspect and remove only its unpublished draft and any unused tag; never replace a published version. If `master` has advanced, start from its current checked revision after resolving that draft. Choose a new version for changes to an already published release.

If a failure requires a workflow or script fix, merge that fix through a reviewed pull request first. Rerunning the old workflow uses its original source revision and will not include the fix. Resolve the unpublished draft as described above, then have the owner start a new release from the updated `master`.

## Local version commands

```bash
npm run check:version
npm run version:set -- v0.0.2
```

The check is part of `npm run check`. The setter updates all five version files consistently and rejects mismatched inputs or a decrease. Use it on `dev` when intentionally advancing the checked-in source version, and include those changes in the normal reviewed pull request.

To reproduce a release, check out its tag, run `npm run version:set -- vX.Y.Z` with that tag's version, install locked dependencies, and use the release workflow's target, bundles, and configuration override with the signing environment. In particular, enable `bundle.createUpdaterArtifacts` for signed update packages. This reproduces the version stamping; native toolchains and operating-system signing settings also affect the resulting bytes.

See the official [Tauri updater documentation](https://v2.tauri.app/plugin/updater/), [Tauri GitHub pipeline guide](https://v2.tauri.app/distribute/pipelines/github/), and [tauri-action inputs](https://github.com/tauri-apps/tauri-action#usage) for signing and packaging details.
