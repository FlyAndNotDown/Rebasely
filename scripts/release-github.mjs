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
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner, repo, workflow_id: "check.yml", branch: "master", event: "push", head_sha: context.sha, per_page: 100,
  });
  const latest = runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (!latest || latest.head_sha !== context.sha || latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("Wait for the Check workflow to succeed on this exact master revision before releasing.");
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner, repo, run_id: latest.id, filter: "latest", per_page: 100,
  });
  for (const name of ["Check on ubuntu-24.04", "Check on windows-latest", "Check on macos-latest"]) {
    if (!jobs.some((job) => job.name === name && job.conclusion === "success")) {
      throw new Error(`Required native check did not succeed: ${name}.`);
    }
  }
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
    body: `Source revision: \`${context.sha}\`.\n\nUpdate packages carry Tauri updater signatures. Windows installers are not Authenticode signed; macOS builds use ad-hoc signing and are not notarized.`,
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
    { platform: "darwin-x86_64", name: `${prefix}macos_x64.app.tar.gz`, installer: `${prefix}macos_x64.dmg` },
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

export function buildUpdaterManifest({ tag, repository, assets, signatures, publicKey, notes, pubDate }) {
  const version = parseReleaseTag(tag);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid release repository.");
  if (!Number.isFinite(Date.parse(pubDate))) throw new Error("Invalid publication date.");
  const platforms = {};
  for (const target of releaseAssets(tag)) {
    const asset = requireAsset(assets, target.name);
    requireAsset(assets, `${target.name}.sig`);
    if (target.installer) requireAsset(assets, target.installer);
    const url = `https://github.com/${repository}/releases/download/${tag}/${target.name}`;
    if (asset.browser_download_url !== url) throw new Error(`Unexpected download URL for ${target.name}.`);
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
    tag, repository: `${owner}/${repo}`, assets, signatures,
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
