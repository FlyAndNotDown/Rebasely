import { checkVersions, parseReleaseTag, validateReleaseVersion } from "./release-version.mjs";
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

export function assertReleaseOwner({ eventName, ref, actor, triggeringActor, owner }) {
  if (eventName !== "workflow_dispatch" || ref !== "refs/heads/master"
    || !owner || actor?.toLowerCase() !== owner.toLowerCase()
    || triggeringActor?.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Only the repository owner may run or rerun a release from master.");
  }
}

function authorize(context) {
  assertReleaseOwner({
    eventName: context.eventName,
    ref: context.ref,
    actor: context.actor,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    owner: context.repo.owner,
  });
}

async function assertCheckedRevision(github, context) {
  const { owner, repo } = context.repo;
  const { data: master } = await github.rest.repos.getBranch({ owner, repo, branch: "master" });
  if (master.commit.sha !== context.sha) throw new Error("master advanced; dispatch a new release from its current revision.");
  const [{ data: commit }, pulls] = await Promise.all([
    github.rest.repos.getCommit({ owner, repo, ref: context.sha }),
    github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: context.sha, per_page: 100 }),
  ]);
  const tree = commit.commit?.tree?.sha;
  if (commit.sha !== context.sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree ?? "")) {
    throw new Error("Could not determine the current master source tree.");
  }
  const repository = `${owner}/${repo}`.toLowerCase();
  const pull = pulls.filter((value) => value.state === "closed" && value.merged_at
    && value.merge_commit_sha === context.sha && value.base?.ref === "master"
    && value.base?.repo?.full_name?.toLowerCase() === repository && value.head?.sha)
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at) || b.number - a.number)[0];
  if (!pull) throw new Error("Current master must come from a merged pull request targeting this repository's master branch.");
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner, repo, workflow_id: "check.yml", event: "pull_request", head_sha: pull.head.sha, per_page: 100,
  });
  // GitHub can update run.pull_requests snapshots when a source branch is reused.
  // The immutable run head and the recorded checkout tree identify the tested source.
  const latest = runs.filter((run) => run.event === "pull_request" && run.head_sha === pull.head.sha
    && run.path === ".github/workflows/check.yml" && run.repository?.full_name?.toLowerCase() === repository)
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("The merged pull request's latest Check workflow must succeed before releasing.");
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner, repo, run_id: latest.id, filter: "latest", per_page: 100,
  });
  const native = [];
  // Keep existing checked-source proofs valid across the job-name migration.
  for (const names of [
    ["Check (Linux)", "Check on ubuntu-24.04"],
    ["Check (Windows)", "Check on windows-latest"],
    ["Check (macOS arm64)", "Check on macos-latest"],
  ]) {
    const name = names[0];
    const matches = jobs.filter((job) => names.includes(job.name));
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`Required native check did not succeed: ${name}.`);
    }
    native.push(matches[0]);
  }
  await Promise.all(native.map(async (job) => {
    const prefix = new URL(`/repos/${owner}/${repo}/check-runs/`, context.apiUrl ?? "https://api.github.com");
    let checkRun;
    try {
      checkRun = new URL(job.check_run_url);
    } catch {
      throw new Error(`Invalid check-run reference for ${job.name}.`);
    }
    const id = checkRun.pathname.slice(prefix.pathname.length);
    if (checkRun.origin !== prefix.origin || !checkRun.pathname.toLowerCase().startsWith(prefix.pathname.toLowerCase())
      || checkRun.search || checkRun.hash || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error(`Invalid check-run reference for ${job.name}.`);
    }
    const annotations = await github.paginate(github.rest.checks.listAnnotations, {
      owner, repo, check_run_id: Number(id), per_page: 100,
    });
    const notices = annotations.filter((annotation) => annotation.title === "Rebasely checked source");
    if (notices.length !== 1 || notices[0].annotation_level !== "notice" || notices[0].message !== tree) {
      throw new Error(`Native check does not prove the current master source tree: ${job.name}. Update the pull request against master and rerun its checks.`);
    }
  }));
}

export async function preflight({ github, context, core, tag }) {
  authorize(context);
  const version = parseReleaseTag(tag);
  const sourceVersion = await checkVersions();
  await assertCheckedRevision(github, context);
  const { owner, repo } = context.repo;
  const [tags, releases] = await Promise.all([
    github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 }),
    github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 }),
  ]);
  validateReleaseVersion(tag, sourceVersion, [...tags.map((value) => value.name), ...releases.map((value) => value.tag_name)]);
  core.setOutput("version", version);
  core.setOutput("tag", tag);
  core.info(`Validated ${tag} from checked master revision ${context.sha}.`);
}

export async function createDraft({ github, context, core, tag }) {
  authorize(context);
  parseReleaseTag(tag);
  await assertCheckedRevision(github, context);
  const [tags, releases] = await Promise.all([
    github.paginate(github.rest.repos.listTags, { ...context.repo, per_page: 100 }),
    github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 }),
  ]);
  validateReleaseVersion(tag, await checkVersions(), [...tags.map((value) => value.name), ...releases.map((value) => value.tag_name)]);
  const { data: release } = await github.rest.repos.createRelease({
    ...context.repo, tag_name: tag, target_commitish: context.sha,
    name: `Rebasely ${tag}`, draft: true, prerelease: false,
    body: `Source revision: \`${context.sha}\`.`,
    generate_release_notes: true,
  });
  core.setOutput("release_id", release.id);
  core.info(`Created draft release for ${tag}.`);
}

export function releaseAssets(tag) {
  parseReleaseTag(tag);
  const prefix = `Rebasely_${tag}_`;
  return [
    { platform: "windows-x86_64", name: `${prefix}windows_x64.exe` },
    { platform: "darwin-aarch64", name: `${prefix}macos_arm64.app.tar.gz`, installer: `${prefix}macos_arm64.dmg` },
    { platform: "linux-x86_64", name: `${prefix}linux_x64.AppImage` },
    { platform: "linux-x86_64-deb", name: `${prefix}linux_x64.deb` },
  ];
}

function requireAsset(assets, name) {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length !== 1 || matches[0].state !== "uploaded" || matches[0].size <= 0) {
    throw new Error(`Required release asset is missing, empty, or incomplete: ${name}.`);
  }
  return matches[0];
}

export function validateUpdaterSignature(value, { version, publicKey } = {}) {
  const signature = value.trim();
  if (signature.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error("Invalid Tauri updater signature encoding.");
  }
  const lines = Buffer.from(signature, "base64").toString("utf8").trim().split(/\r?\n/);
  const packet = Buffer.from(lines[1] ?? "", "base64");
  const globalSignature = Buffer.from(lines[3] ?? "", "base64");
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment: ")
    || !lines[2].startsWith("trusted comment: ") || packet.length !== 74
    || !["Ed", "ED"].includes(packet.subarray(0, 2).toString("ascii")) || globalSignature.length !== 64) {
    throw new Error("Invalid Tauri updater signature format.");
  }
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const signedVersions = trustedComment.split("\t").filter((field) => field.startsWith("version:"));
  if (!version || signedVersions.length !== 1 || signedVersions[0] !== `version:${version}`) {
    throw new Error("Updater signature is not bound to the requested release version.");
  }
  const publicLines = Buffer.from(publicKey ?? "", "base64").toString("utf8").trim().split(/\r?\n/);
  const publicPacket = Buffer.from(publicLines[1] ?? "", "base64");
  if (publicPacket.length !== 42 || publicPacket.subarray(0, 2).toString("ascii") !== "Ed"
    || !packet.subarray(2, 10).equals(publicPacket.subarray(2, 10))) {
    throw new Error("Updater signature does not match the configured public key.");
  }
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicPacket.subarray(10)]),
    format: "der", type: "spki",
  });
  const signedComment = Buffer.concat([packet.subarray(10), Buffer.from(trustedComment, "utf8")]);
  if (!verify(null, signedComment, key, globalSignature)) {
    throw new Error("Updater signature version binding failed cryptographic verification.");
  }
  return signature;
}

export function buildUpdaterManifest({ tag, repository, releaseUrl, assets, signatures, publicKey, notes, pubDate }) {
  const version = parseReleaseTag(tag);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid release repository.");
  if (!Number.isFinite(Date.parse(pubDate))) throw new Error("Invalid publication date.");
  const releasePrefix = `https://github.com/${repository}/releases/tag/`;
  const assetTag = typeof releaseUrl === "string" && releaseUrl.startsWith(releasePrefix) ? releaseUrl.slice(releasePrefix.length) : "";
  if (assetTag !== tag && !/^untagged-[A-Za-z0-9]+$/.test(assetTag)) throw new Error("Unexpected release URL.");
  const platforms = {};
  for (const target of releaseAssets(tag)) {
    const asset = requireAsset(assets, target.name);
    requireAsset(assets, `${target.name}.sig`);
    if (target.installer) requireAsset(assets, target.installer);
    const url = `https://github.com/${repository}/releases/download/${tag}/${target.name}`;
    // Draft assets can use the release page's temporary tag until publication.
    const draftUrl = `https://github.com/${repository}/releases/download/${assetTag}/${target.name}`;
    if (asset.browser_download_url !== url && asset.browser_download_url !== draftUrl) {
      throw new Error(`Unexpected download URL for ${target.name}.`);
    }
    platforms[target.platform] = { signature: validateUpdaterSignature(signatures[target.name] ?? "", { version, publicKey }), url };
  }
  return { version, notes, pub_date: new Date(pubDate).toISOString(), platforms };
}

export async function publishRelease({ github, context, core, tag, releaseId }) {
  authorize(context);
  await assertCheckedRevision(github, context);
  const { owner, repo } = context.repo;
  const release_id = Number(releaseId);
  if (!Number.isSafeInteger(release_id) || release_id <= 0) throw new Error("Invalid draft release id.");
  const { data: release } = await github.rest.repos.getRelease({ owner, repo, release_id });
  if (!release.draft || release.prerelease || release.tag_name !== tag || release.target_commitish !== context.sha) {
    throw new Error("Draft release no longer matches the approved version and source revision.");
  }
  let ref;
  try {
    ref = (await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` })).data.object;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  for (let depth = 0; ref?.type === "tag" && depth < 8; depth++) {
    ref = (await github.rest.git.getTag({ owner, repo, tag_sha: ref.sha })).data.object;
  }
  if (ref && (ref.type !== "commit" || ref.sha !== context.sha)) {
    throw new Error("The release tag points to a different source revision.");
  }
  const [tags, releases] = await Promise.all([
    github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 }),
    github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 }),
  ]);
  validateReleaseVersion(tag, await checkVersions(), [
    ...tags.filter((value) => value.name !== tag).map((value) => value.name),
    ...releases.filter((value) => value.id !== release_id).map((value) => value.tag_name),
  ]);
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id, per_page: 100 });
  const signatures = {};
  for (const target of releaseAssets(tag)) {
    const asset = requireAsset(assets, `${target.name}.sig`);
    if (asset.size > 16384) throw new Error(`Updater signature exceeds the size limit: ${asset.name}.`);
    const { data } = await github.rest.repos.getReleaseAsset({
      owner, repo, asset_id: asset.id, headers: { accept: "application/octet-stream" },
    });
    signatures[target.name] = Buffer.from(data).toString("utf8");
  }
  const manifest = buildUpdaterManifest({
    tag, repository: `${owner}/${repo}`, releaseUrl: release.html_url, assets, signatures,
    publicKey: JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).plugins?.updater?.pubkey,
    notes: release.body ?? "", pubDate: new Date().toISOString(),
  });
  const oldManifest = assets.find((asset) => asset.name === "latest.json");
  if (oldManifest) await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: oldManifest.id });
  const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await github.rest.repos.uploadReleaseAsset({
    owner, repo, release_id, name: "latest.json", data,
    headers: { "content-type": "application/json", "content-length": data.length },
  });
  await github.rest.repos.updateRelease({ owner, repo, release_id, draft: false, make_latest: "true" });
  core.info(`Published Rebasely ${tag} with all updater packages.`);
}
