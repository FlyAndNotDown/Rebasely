import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyBinaryDiff } from "@/lib/git";
import type { P4Changelist, P4File } from "@/types/p4";
import { defaultChange, fileKey, refreshPendingSession, sameP4Connection, shownFile, updateP4Session, usableP4Session, type P4Session } from "./p4-session";

function file(name: string): P4File {
  return {
    depotPath: `//depot/main/${name}`, localPath: `C:\\work\\client\\${name}`,
    action: "edit", rev: "3", shelved: false, binary: false, status: "edit", detail: "",
  };
}

function change(id = "42", description = "Saved description", files = [file("a.txt"), file("b.txt")]): P4Changelist {
  return { id, description, files, user: "alice", client: "dev-pc", status: "pending", time: 0, shelved: false };
}

function session(tabId = "p4:client-a"): P4Session {
  const pending = [change()];
  return {
    tabId,
    connection: { root: "C:\\work\\client", port: "ssl:perforce.example.com:1666", user: "alice", client: "dev-pc", charset: "utf8", stream: null, server: "" },
    pending, selectedChange: "42", selectedFile: "//depot/main/b.txt", selectedShelved: false,
    description: pending[0].description, diff: emptyBinaryDiff("b.txt"), diffFor: fileKey("42", "//depot/main/b.txt", false),
    submitted: [], submittedHasMore: true, selectedSubmitted: null, submittedDetail: null,
    submittedDiffs: [], submittedUser: "", submittedClient: "", view: "pending",
  };
}

beforeEach(() => vi.stubGlobal("navigator", { userAgent: "Windows" }));
afterEach(() => vi.unstubAllGlobals());

describe("initial pending changelist selection", () => {
  it("prefers a nonempty default changelist even when another change comes first", () => {
    expect(defaultChange([change(), change("default")])).toBe("default");
    expect(defaultChange([change(), { ...change("default", "", []), shelved: true }])).toBe("default");
  });

  it("skips an empty default and other empty changelists for the first opened files", () => {
    expect(defaultChange([change("default", "", []), change("41", "Empty", []), change()])).toBe("42");
  });

  it("includes shelf-only changes and selects their shelved file", () => {
    const shelf = { ...change("43", "Shelved", [{ ...file("shelf.txt"), shelved: true }]), shelved: true };
    const pending = [change("default", "", []), shelf];
    const selected = pending.find((item) => item.id === defaultChange(pending));
    expect(selected?.id).toBe("43");
    expect(shownFile(selected?.files ?? [])).toEqual({ path: "//depot/main/shelf.txt", shelved: true });
    expect(defaultChange([change("default", "", []), { ...shelf, files: [] }])).toBe("43");
  });

  it("falls back to the empty default, first change, or default identifier", () => {
    expect(defaultChange([change("42", "Empty", []), change("default", "", [])])).toBe("default");
    expect(defaultChange([change("42", "Empty", []), change("43", "Empty", [])])).toBe("42");
    expect(defaultChange([])).toBe("default");
  });
});

describe("pending workspace refreshes", () => {
  it("preserves a user's valid empty selection when other changelists have content", () => {
    const empty = change("default", "", []);
    const current = { ...session(), pending: [empty, change()], selectedChange: "default", selectedFile: null, description: "", diff: null };
    expect(refreshPendingSession(current, [empty, change()]).selectedChange).toBe("default");
    const numbered = change("43", "Empty", []);
    const selected = { ...current, selectedChange: "43", pending: [numbered], description: "Empty" };
    expect(refreshPendingSession(selected, [change("default"), numbered]).selectedChange).toBe("43");
  });

  it("retains the selected shelf path when the default gains opened files", () => {
    const shelf = change("42", "Shelved", [{ ...file("b.txt"), shelved: true }]);
    const current = { ...session(), pending: [shelf], selectedShelved: true, description: "Shelved" };
    const refreshed = refreshPendingSession(current, [change("default"), shelf]);
    expect(refreshed.selectedChange).toBe("42");
    expect(refreshed.selectedFile).toBe("//depot/main/b.txt");
    expect(refreshed.selectedShelved).toBe(true);
    expect(refreshed.diff).toBe(current.diff);
  });

  it("retains an edited description and the latest file selection", () => {
    const current = { ...session(), description: "An unsaved description" };
    const refreshed = refreshPendingSession(current, [change("42", "A server-side edit")]);
    expect(refreshed.description).toBe("An unsaved description");
    expect(refreshed.selectedFile).toBe("//depot/main/b.txt");
    expect(refreshed.diff).toBe(current.diff);
    expect(refreshed.diffFor).toBe("");
  });

  it("updates an unedited description from the server", () => {
    expect(refreshPendingSession(session(), [change("42", "Updated description")]).description).toBe("Updated description");
  });

  it("does not restore an operation's preferred changelist after the user changes selection", () => {
    const current = { ...session(), selectedChange: "43", pending: [change(), change("43", "Another change")], description: "Another change" };
    const refreshed = refreshPendingSession(current, [change(), change("43", "Fresh description")], "42", "42");
    expect(refreshed.selectedChange).toBe("43");
    expect(refreshed.description).toBe("Fresh description");
  });

  it("does not move another changelist's draft to a replacement selection", () => {
    const current = { ...session(), description: "Draft for the old change" };
    const refreshed = refreshPendingSession(current, [change("43", "Different changelist", [file("c.txt")])]);
    expect(refreshed.selectedChange).toBe("43");
    expect(refreshed.description).toBe("Different changelist");
    expect(refreshed.selectedFile).toBe("//depot/main/c.txt");
    expect(refreshed.diff).toBeNull();
  });

  it("clears stale descriptions and file diffs when no changelists remain", () => {
    const refreshed = refreshPendingSession(session(), []);
    expect(refreshed.selectedChange).toBe("default");
    expect(refreshed.description).toBe("");
    expect(refreshed.selectedFile).toBeNull();
    expect(refreshed.diff).toBeNull();
  });
});

describe("workspace request ownership", () => {
  it("does not expose a cached connection for actions while reconnecting or after failure", () => {
    const previous = { ...session(), description: "Keep the previous server's draft" };
    expect(usableP4Session(previous, previous.tabId, false, null)).toBe(previous);
    expect(usableP4Session(previous, previous.tabId, true, null)).toBeNull();
    expect(usableP4Session(previous, previous.tabId, false, "Connection failed")).toBeNull();
    expect(previous.description).toBe("Keep the previous server's draft");
    const reconnected = { ...previous, connection: { ...previous.connection, port: "ssl:other.example.com:1666" } };
    expect(usableP4Session(reconnected, previous.tabId, false, null)).toBe(reconnected);
  });

  it("distinguishes connections after reconnecting the same workspace root", () => {
    const connection = session().connection;
    expect(sameP4Connection(connection, { ...connection, root: "c:/work/client/" })).toBe(true);
    expect(sameP4Connection(connection, { ...connection, port: "ssl:other.example.com:1666" })).toBe(false);
    expect(sameP4Connection(connection, { ...connection, user: "bob" })).toBe(false);
    expect(sameP4Connection(connection, { ...connection, client: "build-pc" })).toBe(false);
  });

  it("applies a delayed result to its original workspace after switching tabs", async () => {
    const a = session("p4:client-a");
    const b = { ...session("p4:client-b"), description: "Keep this workspace's draft" };
    const sessions = new Map([[a.tabId, a], [b.tabId, b]]);
    let finish!: (pending: P4Changelist[]) => void;
    const request = new Promise<P4Changelist[]>((resolve) => { finish = resolve; });
    const refresh = request.then((pending) => updateP4Session(sessions, a.tabId, (latest) => refreshPendingSession(latest, pending)));

    const activeTab = b.tabId;
    updateP4Session(sessions, a.tabId, (latest) => ({ ...latest, description: "Typed while refreshing" }));
    finish([change("42", "Fresh server data")]);
    await refresh;

    expect(sessions.get(activeTab)).toBe(b);
    expect(sessions.get(a.tabId)?.pending[0].description).toBe("Fresh server data");
    expect(sessions.get(a.tabId)?.description).toBe("Typed while refreshing");
  });

  it("does not resurrect a session removed while a request was in flight", () => {
    const sessions = new Map<string, P4Session>();
    expect(updateP4Session(sessions, "p4:closed-client", () => session())).toBeNull();
    expect(sessions.size).toBe(0);
  });
});
