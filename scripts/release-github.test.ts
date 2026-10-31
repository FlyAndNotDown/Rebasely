import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertReleaseOwner, buildUpdaterManifest, preflight, publishRelease, releaseAssets, validateUpdaterSignature } from "./release-github.mjs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(readFile).mockReset();
});

function fixture() {
  const assets = releaseAssets(tag).flatMap((target: { name: string; installer?: string }) => [
    target.name, `${target.name}.sig`, ...(target.installer ? [target.installer] : []),
  ]).map((name: string, index: number) => ({
    id: index + 1, name, state: "uploaded", size: 100,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  }));
  const signatures = Object.fromEntries(releaseAssets(tag).map((target: { name: string }) => [target.name, signature]));
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  return { tag, repository, releaseUrl, assets, signatures, publicKey, notes: "Release notes", pubDate: "2026-01-01T00:00:00Z" };
}

function draftFixture() {
  const input = fixture();
  const draftTag = "untagged-a1b2c3d4";
  input.releaseUrl = `https://github.com/${repository}/releases/tag/${draftTag}`;
  for (const asset of input.assets) {
    asset.browser_download_url = `https://github.com/${repository}/releases/download/${draftTag}/${asset.name}`;
  }
  return input;
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
  const head = "b".repeat(40);
  const tree = "c".repeat(40);
  const context = { eventName: "workflow_dispatch", ref: "refs/heads/master", actor: "maintainer", sha, repo: { owner: "maintainer", repo: "sample-app" } };
  const lists = {
    tags: [{ name: "v0.0.1" }],
    releases: [] as { id?: number; tag_name: string }[],
    pulls: [{
      number: 42, state: "closed", merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: sha,
      base: { ref: "master", repo: { full_name: repository } }, head: { sha: head },
    }],
    runs: [{
      id: 7, run_number: 2, head_sha: head, status: "completed", conclusion: "success", event: "pull_request",
      path: ".github/workflows/check.yml", repository: { full_name: repository },
      pull_requests: [{ number: 42, head: { sha: head } }],
    }],
    jobs: ["Check (Linux)", "Check (Windows)", "Check (macOS arm64)"].map((name, index) => ({
      name, status: "completed", conclusion: "success", check_run_url: `https://api.github.com/repos/${repository}/check-runs/${101 + index}`,
    })),
    annotations: new Map([101, 102, 103].map((id) => [id, [{ annotation_level: "notice", title: "Rebasely checked source", message: tree }]])),
  };
  const github = {
    rest: {
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha } } })),
        getCommit: vi.fn(async () => ({ data: { sha, commit: { tree: { sha: tree } } } })),
        listPullRequestsAssociatedWithCommit: vi.fn(), listTags: vi.fn(), listReleases: vi.fn(),
      },
      actions: { listWorkflowRuns: vi.fn(), listJobsForWorkflowRun: vi.fn() },
      checks: { listAnnotations: vi.fn() },
    },
    paginate: vi.fn(async (method: unknown, parameters: { check_run_id?: number } = {}) => {
      if (method === github.rest.repos.listTags) return lists.tags;
      if (method === github.rest.repos.listReleases) return lists.releases;
      if (method === github.rest.repos.listPullRequestsAssociatedWithCommit) return lists.pulls;
      if (method === github.rest.actions.listWorkflowRuns) return lists.runs;
      if (method === github.rest.actions.listJobsForWorkflowRun) return lists.jobs;
      if (method === github.rest.checks.listAnnotations) return lists.annotations.get(parameters.check_run_id ?? 0) ?? [];
      throw new Error("Unexpected test API call");
    }),
  };
  const core = { setOutput: vi.fn(), info: vi.fn() };
  return { github, context, core, lists, tree };
}

describe("release preflight", () => {
  it("uses the merged PR head for checks and requires the exact final master tree", async () => {
    const input = githubFixture();
    await preflight({ ...input, tag: "v1.0.0" });
    expect(input.core.setOutput).toHaveBeenCalledWith("version", "1.0.0");
    expect(input.core.setOutput).toHaveBeenCalledWith("tag", "v1.0.0");
    expect(input.github.paginate).toHaveBeenCalledWith(input.github.rest.actions.listWorkflowRuns, expect.objectContaining({
      head_sha: input.lists.pulls[0].head.sha, event: "pull_request", workflow_id: "check.yml",
    }));
    expect(input.lists.pulls[0].head.sha).not.toBe(input.context.sha);
    for (const id of [101, 102, 103]) {
      expect(input.github.paginate).toHaveBeenCalledWith(input.github.rest.checks.listAnnotations, expect.objectContaining({ check_run_id: id }));
    }
  });

  it("accepts prior native job names without weakening source proofs", async () => {
    const input = githubFixture();
    ["Check on ubuntu-24.04", "Check on windows-latest", "Check on macos-latest"].forEach((name, index) => {
      input.lists.jobs[index].name = name;
    });
    await expect(preflight({ ...input, tag: "v1.0.0" })).resolves.toBeUndefined();
    input.lists.annotations.set(101, []);
    await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("does not prove the current master source tree");
  });

  it("rejects duplicate native jobs across old and new names", async () => {
    const input = githubFixture();
    input.lists.jobs.push({ ...input.lists.jobs[0], name: "Check on ubuntu-24.04" });
    await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("Required native check");
  });

  it("ignores mutable PR snapshots after the dev branch is reused", async () => {
    const input = githubFixture();
    input.lists.runs[0].pull_requests = [{ number: 99, head: { sha: "d".repeat(40) } }];
    await expect(preflight({ ...input, tag: "v1.0.0" })).resolves.toBeUndefined();
    expect(input.core.setOutput).toHaveBeenCalledWith("tag", "v1.0.0");
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
    await expect(preflight({ ...failed, tag: "v1.0.0" })).rejects.toThrow("latest Check workflow must succeed");
    const wrongRevision = githubFixture();
    wrongRevision.lists.runs[0].head_sha = wrongRevision.context.sha;
    await expect(preflight({ ...wrongRevision, tag: "v1.0.0" })).rejects.toThrow("latest Check workflow must succeed");
    const missingNative = githubFixture();
    missingNative.lists.jobs.pop();
    await expect(preflight({ ...missingNative, tag: "v1.0.0" })).rejects.toThrow("Required native check");
  });

  it("does not fall back to an older success after the latest PR run fails", async () => {
    const input = githubFixture();
    input.lists.runs.push({ ...input.lists.runs[0], id: 8, run_number: 3, conclusion: "failure" });
    await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("latest Check workflow must succeed");
    expect(input.core.setOutput).not.toHaveBeenCalled();
  });

  it("requires the exact merged PR, master base, and repository", async () => {
    const inputs = [githubFixture(), githubFixture(), githubFixture(), githubFixture(), githubFixture()];
    inputs[0].lists.pulls[0].base.ref = "dev";
    inputs[1].lists.pulls[0].base.repo.full_name = "maintainer/other-app";
    inputs[2].lists.pulls[0].merge_commit_sha = "d".repeat(40);
    inputs[3].lists.pulls[0].state = "open";
    inputs[4].lists.pulls = [];
    for (const input of inputs) {
      await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("merged pull request targeting");
      expect(input.core.setOutput).not.toHaveBeenCalled();
    }
  });

  it("ignores push runs and runs from another workflow or repository", async () => {
    const inputs = [githubFixture(), githubFixture(), githubFixture()];
    inputs[0].lists.runs[0].event = "push";
    inputs[1].lists.runs[0].path = ".github/workflows/other.yml";
    inputs[2].lists.runs[0].repository.full_name = "maintainer/other-app";
    for (const input of inputs) {
      await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("latest Check workflow must succeed");
    }
  });

  it("rejects missing, duplicate, wrong-level, or stale source tree annotations", async () => {
    const inputs = [githubFixture(), githubFixture(), githubFixture(), githubFixture()];
    inputs[0].lists.annotations.set(101, []);
    const duplicate = { annotation_level: "notice", title: "Rebasely checked source", message: inputs[1].tree };
    inputs[1].lists.annotations.set(102, [duplicate, duplicate]);
    inputs[2].lists.annotations.set(103, [{ annotation_level: "warning", title: "Rebasely checked source", message: inputs[2].tree }]);
    inputs[3].lists.annotations.set(101, [{ annotation_level: "notice", title: "Rebasely checked source", message: "d".repeat(40) }]);
    for (const input of inputs) {
      await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("does not prove the current master source tree");
      expect(input.core.setOutput).not.toHaveBeenCalled();
    }
  });

  it("refuses an annotation reference outside the current repository", async () => {
    const input = githubFixture();
    input.lists.jobs[0].check_run_url = "https://api.github.com/repos/maintainer/other-app/check-runs/101";
    await expect(preflight({ ...input, tag: "v1.0.0" })).rejects.toThrow("Invalid check-run reference");
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
  const release = {
    id: 99, draft: true, prerelease: false, tag_name: tag, target_commitish: input.context.sha,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
  };
  input.lists.releases.push(release);
  const repos = {
    ...input.github.rest.repos,
    getRelease: vi.fn(async () => ({ data: release })),
    listReleaseAssets: vi.fn(),
    getReleaseAsset: vi.fn(async () => ({ data: Buffer.from(signature) })),
    updateRelease: vi.fn(),
    uploadReleaseAsset: vi.fn(async (_parameters: {
      owner: string; repo: string; release_id: number; name: string; data: Buffer;
      headers: Record<string, string | number>;
    }) => undefined),
    deleteReleaseAsset: vi.fn(),
  };
  const git = {
    getRef: vi.fn(async () => ({ data: { object: { type: "commit", sha: input.context.sha } } })),
    getTag: vi.fn(),
  };
  const assets: ReturnType<typeof fixture>["assets"] = [];
  const github = {
    ...input.github,
    rest: { ...input.github.rest, repos, git },
    paginate: vi.fn(async (method: unknown, parameters: { check_run_id?: number } = {}) => method === repos.listReleaseAssets ? assets : input.github.paginate(method, parameters)),
  };
  return { ...input, github, release, assets, tag, releaseId: "99" };
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

  it("uploads versioned updater URLs before publishing a complete untagged draft", async () => {
    const input = publishFixture();
    const draft = draftFixture();
    input.release.html_url = draft.releaseUrl;
    input.assets.push(...draft.assets);
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const configUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url).href;
    vi.mocked(readFile).mockImplementation((async (file, options) => {
      if (file instanceof URL && file.href === configUrl) {
        const config = JSON.parse(await original.readFile(file, "utf8"));
        config.plugins.updater.pubkey = publicKey;
        return JSON.stringify(config);
      }
      return original.readFile(file, options);
    }) as typeof readFile);

    await publishRelease(input);

    const repos = input.github.rest.repos;
    expect(repos.uploadReleaseAsset).toHaveBeenCalledOnce();
    const upload = repos.uploadReleaseAsset.mock.calls[0][0];
    expect(upload).toMatchObject({ ...input.context.repo, release_id: 99, name: "latest.json" });
    const manifest = JSON.parse(upload.data.toString("utf8"));
    for (const target of releaseAssets(tag)) {
      expect(manifest.platforms[target.platform]).toEqual({
        signature, url: `https://github.com/${repository}/releases/download/${tag}/${target.name}`,
      });
    }
    expect(repos.updateRelease).toHaveBeenCalledWith({
      ...input.context.repo, release_id: 99, draft: false, make_latest: "true",
    });
    expect(repos.uploadReleaseAsset.mock.invocationCallOrder[0]).toBeLessThan(repos.updateRelease.mock.invocationCallOrder[0]);
  });
});

describe("release updater manifest", () => {
  it("assembles every platform in one manifest with versioned public asset URLs", () => {
    const manifest = buildUpdaterManifest(fixture());
    expect(manifest.version).toBe("0.0.1");
    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "linux-x86_64", "linux-x86_64-deb", "windows-x86_64"]);
    expect(manifest.platforms).toHaveProperty("windows-x86_64.url", expect.stringContaining("/v0.0.1/Rebasely_v0.0.1_windows_x64.exe"));
    expect(manifest.platforms).toHaveProperty("darwin-aarch64.signature", signature);
    expect(manifest.platforms).toHaveProperty("linux-x86_64-deb.url", expect.stringMatching(/\.deb$/));
    expect(manifest.platforms).toHaveProperty("linux-x86_64.url", expect.stringMatching(/\.AppImage$/));
  });

  it("normalizes every draft platform URL to its final versioned download URL", () => {
    const manifest = buildUpdaterManifest(draftFixture());
    for (const target of releaseAssets(tag)) {
      expect(manifest.platforms).toHaveProperty(target.platform, {
        signature, url: `https://github.com/${repository}/releases/download/${tag}/${target.name}`,
      });
    }
    expect(JSON.stringify(manifest)).not.toContain("untagged-");
  });

  it("accepts final download URLs when a draft release still has an untagged page", () => {
    const input = draftFixture();
    input.assets = fixture().assets;
    expect(buildUpdaterManifest(input)).toEqual(buildUpdaterManifest(fixture()));
  });

  it("rejects release pages outside the repository, requested tag, or draft namespace", () => {
    for (const releaseUrl of [
      undefined,
      "",
      `http://github.com/${repository}/releases/tag/${tag}`,
      `https://example.com/${repository}/releases/tag/${tag}`,
      `https://github.com/maintainer/other-app/releases/tag/${tag}`,
      `https://github.com/${repository}/releases/tag/v0.0.2`,
      `https://github.com/${repository}/releases/tag/untagged-`,
      `https://github.com/${repository}/releases/tag/untagged-a1-b2`,
      `https://github.com/${repository}/releases/tag/untagged-a1/extra`,
      `https://github.com/${repository}/releases/tag/${tag}?draft=true`,
      `https://github.com/${repository}/releases/tag/${tag}#assets`,
      `https://github.com/${repository}/releases/tag/untagged-a1?draft=true`,
    ]) {
      expect(() => buildUpdaterManifest({ ...fixture(), releaseUrl })).toThrow("Unexpected release URL");
    }
  });

  it("rejects download URLs that do not match the release page or exact asset", () => {
    const name = releaseAssets(tag)[0].name;
    for (const browserDownloadUrl of [
      `http://github.com/${repository}/releases/download/untagged-a1b2c3d4/${name}`,
      `https://example.com/${repository}/releases/download/untagged-a1b2c3d4/${name}`,
      `https://github.com/maintainer/other-app/releases/download/untagged-a1b2c3d4/${name}`,
      `https://github.com/${repository}/releases/download/v0.0.2/${name}`,
      `https://github.com/${repository}/releases/download/untagged-otherdraft/${name}`,
      `https://github.com/${repository}/releases/download/untagged-a1b2c3d4/other.exe`,
      `https://github.com/${repository}/releases/download/untagged-a1b2c3d4/${name}?download=1`,
      `https://github.com/${repository}/releases/download/untagged-a1b2c3d4/${name}#asset`,
    ]) {
      const input = draftFixture();
      input.assets[0].browser_download_url = browserDownloadUrl;
      expect(() => buildUpdaterManifest(input)).toThrow("Unexpected download URL");
    }
    const input = fixture();
    input.assets[0].browser_download_url = `https://github.com/${repository}/releases/download/untagged-a1b2c3d4/${name}`;
    expect(() => buildUpdaterManifest(input)).toThrow("Unexpected download URL");
  });

  it("refuses partial uploads, missing signatures, and missing installer packages", () => {
    for (const missing of ["Rebasely_v0.0.1_linux_x64.AppImage", "Rebasely_v0.0.1_windows_x64.exe.sig", "Rebasely_v0.0.1_macos_arm64.dmg"]) {
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
