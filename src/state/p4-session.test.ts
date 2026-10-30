import { describe, expect, it } from "vitest";
import { emptyBinaryDiff } from "@/lib/git";
import type { P4Changelist, P4File } from "@/types/p4";
import { fileKey, refreshPendingSession, sameP4Connection, updateP4Session, type P4Session } from "./p4-session";

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

describe("pending workspace refreshes", () => {
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
