import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { assertReleaseOwner, buildUpdaterManifest, preflight, publishRelease, releaseAssets, validateUpdaterSignature } from "./release-github.mjs";

const tag = "v0.0.1";
const repository = "maintainer/sample-app";
const packet = Buffer.alloc(74);
packet.write("ED", "ascii");
const keys = generateKeyPairSync("ed25519");
const publicPacket = Buffer.concat([Buffer.from("Ed"), packet.subarray(2, 10), keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
const publicKey = Buffer.from(`untrusted comment: fixture public key\n${publicPacket.toString("base64")}\n`).toString("base64");
const trustedComment = "timestamp:1\tfile:fixture.bin\tversion:0.0.1";
const commentSignature = sign(null, Buffer.concat([packet.subarray(10), Buffer.from(trustedComment)]), keys.privateKey);
const signature = Buffer.from(`untrusted comment: fixture signature\n${packet.toString("base64")}\ntrusted comment: ${trustedComment}\n${commentSignature.toString("base64")}\n`).toString("base64");

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const assets = releaseAssets(tag).flatMap((target: { name: string; installer?: string }) => [
    target.name, `${target.name}.sig`, ...(target.installer ? [target.installer] : []),
  ]).map((name: string) => ({
    name, state: "uploaded", size: 100,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  }));
  const signatures = Object.fromEntries(releaseAssets(tag).map((target: { name: string }) => [target.name, signature]));
  return { tag, repository, assets, signatures, publicKey, notes: "Release notes", pubDate: "2026-01-01T00:00:00Z" };
}

describe("release authorization", () => {
  const owner = { eventName: "workflow_dispatch", ref: "refs/heads/master", actor: "maintainer", triggeringActor: "maintainer", owner: "maintainer" };

  it("accepts only a manual master release started and rerun by its owner", () => {
    expect(() => assertReleaseOwner(owner)).not.toThrow();
    for (const change of [
      { actor: "contributor" }, { triggeringActor: "contributor" },
      { triggeringActor: undefined }, { ref: "refs/heads/dev" },
      { ref: "refs/tags/v0.0.1" }, { eventName: "push" }, { eventName: "pull_request" },
    ]) expect(() => assertReleaseOwner({ ...owner, ...change })).toThrow("Only the repository owner");
  });
});

function githubFixture() {
  vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "maintainer");
  const sha = "a".repeat(40);
  const context = { eventName: "workflow_dispatch", ref: "refs/heads/master", actor: "maintainer", sha, repo: { owner: "maintainer", repo: "sample-app" } };
  const lists = {
    tags: [{ name: "v0.0.1" }],
    releases: [] as { id?: number; tag_name: string }[],
    runs: [{ id: 7, run_number: 2, head_sha: sha, status: "completed", conclusion: "success" }],
    jobs: ["Check on ubuntu-24.04", "Check on windows-latest", "Check on macos-latest"].map((name) => ({ name, conclusion: "success" })),
  };
  const github = {
    rest: {
      repos: { getBranch: vi.fn(async () => ({ data: { commit: { sha } } })), listTags: vi.fn(), listReleases: vi.fn() },
      actions: { listWorkflowRuns: vi.fn(), listJobsForWorkflowRun: vi.fn() },
    },
    paginate: vi.fn(async (method: unknown) => {
      if (method === github.rest.repos.listTags) return lists.tags;
      if (method === github.rest.repos.listReleases) return lists.releases;
      if (method === github.rest.actions.listWorkflowRuns) return lists.runs;
      if (method === github.rest.actions.listJobsForWorkflowRun) return lists.jobs;
      throw new Error("Unexpected test API call");
    }),
  };
  const core = { setOutput: vi.fn(), info: vi.fn() };
  return { github, context, core, lists };
}

describe("release preflight", () => {
  it("accepts an owner request only after all native checks on the exact revision", async () => {
    const input = githubFixture();
    await preflight({ ...input, tag: "v1.0.0" });
    expect(input.core.setOutput).toHaveBeenCalledWith("version", "1.0.0");
    expect(input.core.setOutput).toHaveBeenCalledWith("tag", "v1.0.0");
    expect(input.github.paginate).toHaveBeenCalledWith(input.github.rest.actions.listWorkflowRuns, expect.objectContaining({
      head_sha: input.context.sha, branch: "master", event: "push", workflow_id: "check.yml",
    }));
  });

  it("rejects a collaborator rerun before any API calls", async () => {
    const input = githubFixture();
    vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "contributor");
    await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("Only the repository owner");
    expect(input.github.rest.repos.getBranch).not.toHaveBeenCalled();
    expect(input.core.setOutput).not.toHaveBeenCalled();
  });

  it("rejects an advanced master, an unchecked revision, and incomplete native checks", async () => {
    const advanced = githubFixture();
    advanced.github.rest.repos.getBranch.mockResolvedValue({ data: { commit: { sha: "b".repeat(40) } } });
    await expect(preflight({ ...advanced, tag: "v1.0.0" })).rejects.toThrow("master advanced");
    const failed = githubFixture();
    failed.lists.runs[0].conclusion = "failure";
    await expect(preflight({ ...failed, tag: "v1.0.0" })).rejects.toThrow("exact master revision");
    const wrongRevision = githubFixture();
    wrongRevision.lists.runs[0].head_sha = "b".repeat(40);
    await expect(preflight({ ...wrongRevision, tag: "v1.0.0" })).rejects.toThrow("exact master revision");
    const missingNative = githubFixture();
    missingNative.lists.jobs.pop();
    await expect(preflight({ ...missingNative, tag: "v1.0.0" })).rejects.toThrow("Required native check");
  });

  it("rejects existing tags and reserved drafts without producing release outputs", async () => {
    const existing = githubFixture();
    existing.lists.tags.push({ name: "v1.0.0" });
    await expect(preflight({ ...existing, tag: "v1.0.0" })).rejects.toThrow("already exists");
    expect(existing.core.setOutput).not.toHaveBeenCalled();
    const draft = githubFixture();
    draft.lists.releases.push({ tag_name: "v1.1.0" });
    await expect(preflight({ ...draft, tag: "v1.0.0" })).rejects.toThrow("must be newer");
    expect(draft.core.setOutput).not.toHaveBeenCalled();
  });
});

function publishFixture() {
  const input = githubFixture();
  const release = { id: 99, draft: true, prerelease: false, tag_name: tag, target_commitish: input.context.sha };
  input.lists.releases.push(release);
  const repos = {
    ...input.github.rest.repos,
    getRelease: vi.fn(async () => ({ data: release })),
    listReleaseAssets: vi.fn(),
    updateRelease: vi.fn(),
    uploadReleaseAsset: vi.fn(),
    deleteReleaseAsset: vi.fn(),
  };
  const git = {
    getRef: vi.fn(async () => ({ data: { object: { type: "commit", sha: input.context.sha } } })),
    getTag: vi.fn(),
  };
  const github = {
    ...input.github,
    rest: { ...input.github.rest, repos, git },
    paginate: vi.fn(async (method: unknown) => method === repos.listReleaseAssets ? [] : input.github.paginate(method)),
  };
  return { ...input, github, release, tag, releaseId: "99" };
}

describe("release publication guards", () => {
  it("does not modify an already published release", async () => {
    const input = publishFixture();
    input.release.draft = false;
    await expect(publishRelease(input)).rejects.toThrow("Draft release no longer matches");
    expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
    expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  });

  it("does not publish a tag that was redirected to another commit", async () => {
    const input = publishFixture();
    input.github.rest.git.getRef.mockResolvedValue({ data: { object: { type: "commit", sha: "b".repeat(40) } } });
    await expect(publishRelease(input)).rejects.toThrow("different source revision");
    expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
    expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  });

  it("leaves a draft untouched when required platform uploads are missing", async () => {
    const input = publishFixture();
    await expect(publishRelease(input)).rejects.toThrow("Required release asset");
    expect(input.github.rest.repos.updateRelease).not.toHaveBeenCalled();
    expect(input.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(input.github.rest.repos.deleteReleaseAsset).not.toHaveBeenCalled();
  });
});

describe("release updater manifest", () => {
  it("assembles every platform in one manifest with versioned public asset URLs", () => {
    const manifest = buildUpdaterManifest(fixture());
    expect(manifest.version).toBe("0.0.1");
    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "linux-x86_64-deb", "windows-x86_64"]);
    expect(manifest.platforms["windows-x86_64"].url).toContain("/v0.0.1/Rebasely_v0.0.1_windows_x64.exe");
    expect(manifest.platforms["darwin-aarch64"].signature).toBe(signature);
    expect(manifest.platforms["linux-x86_64-deb"].url).toMatch(/\.deb$/);
    expect(manifest.platforms["linux-x86_64"].url).toMatch(/\.AppImage$/);
  });

  it("refuses partial uploads, missing signatures, and missing installer packages", () => {
    for (const missing of ["Rebasely_v0.0.1_linux_x64.AppImage", "Rebasely_v0.0.1_windows_x64.exe.sig", "Rebasely_v0.0.1_macos_x64.dmg"]) {
      const input = fixture();
      input.assets = input.assets.filter((asset: { name: string }) => asset.name !== missing);
      expect(() => buildUpdaterManifest(input)).toThrow("Required release asset");
    }
    const input = fixture();
    input.assets[0].state = "starter";
    expect(() => buildUpdaterManifest(input)).toThrow("incomplete");
  });

  it("rejects altered asset origins and malformed signature content", () => {
    const input = fixture();
    input.assets[0].browser_download_url = "https://example.com/package.exe";
    expect(() => buildUpdaterManifest(input)).toThrow("Unexpected download URL");
    expect(validateUpdaterSignature(`${signature}\n`, { version: "0.0.1", publicKey })).toBe(signature);
    for (const value of ["", "not a signature", "A".repeat(16385), Buffer.from("invalid envelope").toString("base64")]) {
      expect(() => validateUpdaterSignature(value, { version: "0.0.1", publicKey })).toThrow("Invalid Tauri updater signature");
    }
  });

  it("requires the signed release version and its configured key", () => {
    expect(() => validateUpdaterSignature(signature, { version: "0.0.2", publicKey })).toThrow("requested release version");
    expect(() => validateUpdaterSignature(signature, { version: "0.0.1", publicKey: "" })).toThrow("configured public key");
    const tampered = Buffer.from(Buffer.from(signature, "base64").toString("utf8").replace("version:0.0.1", "version:0.0.2")).toString("base64");
    expect(() => validateUpdaterSignature(tampered, { version: "0.0.2", publicKey })).toThrow("cryptographic verification");
  });
});
