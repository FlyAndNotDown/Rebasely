import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_MISSING, gitApi } from "@/lib/git";
import { p4Api } from "@/lib/p4";
import { defaultPrefs } from "@/lib/prefs";
import { loadSettingsData } from "./settings-data";

beforeEach(() => {
  vi.spyOn(gitApi, "getGitIdentity").mockResolvedValue({ name: "alice", email: "alice@example.com" });
  vi.spyOn(gitApi, "getPrefs").mockResolvedValue(defaultPrefs);
  vi.spyOn(gitApi, "listTerminals").mockResolvedValue([]);
  vi.spyOn(gitApi, "listEditors").mockResolvedValue([{ id: "system", name: "System default app", available: true }]);
  vi.spyOn(gitApi, "getToolConfig").mockResolvedValue({ diffTool: "", mergeTool: "" });
  vi.spyOn(gitApi, "listGuiTools").mockResolvedValue([]);
  vi.spyOn(gitApi, "gitExecutables").mockResolvedValue({ pathGit: null, active: null });
  vi.spyOn(p4Api, "executables").mockResolvedValue({ pathP4: null, active: null });
});

afterEach(() => vi.restoreAllMocks());

describe("settings recovery", () => {
  it("keeps executable and native settings available when Git is missing", async () => {
    vi.mocked(gitApi.getGitIdentity).mockRejectedValue(new Error(GIT_MISSING));
    vi.mocked(gitApi.getToolConfig).mockRejectedValue(new Error(GIT_MISSING));
    const result = await loadSettingsData();
    expect(result.identity).toBeNull();
    expect(result.tools).toBeNull();
    expect(result.gitExecutables).toEqual({ pathGit: null, active: null });
    expect(result.p4Executables).toEqual({ pathP4: null, active: null });
    expect(result.editors?.[0].id).toBe("system");
    expect(result.prefs).toBe(defaultPrefs);
    expect(result.incomplete).toBe(true);
  });

  it("does not discard successful settings after an unrelated native discovery failure", async () => {
    vi.mocked(gitApi.listTerminals).mockRejectedValue(new Error("Discovery failed"));
    const result = await loadSettingsData();
    expect(result.terminals).toBeNull();
    expect(result.identity?.email).toBe("alice@example.com");
    expect(result.tools).toEqual({ diffTool: "", mergeTool: "" });
    expect(result.incomplete).toBe(true);
  });

  it("completes when all settings load", async () => {
    expect((await loadSettingsData()).incomplete).toBe(false);
  });
});
