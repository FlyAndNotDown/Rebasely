import { describe, expect, it } from "vitest";
import { createP4PreviewGate, p4DisplayError, p4OperationErrorKey, p4OperationKey } from "./p4-operation-preview";
import { i18n } from "@/i18n";
import type { P4Connection, P4IntegrateRequest, P4UndoRequest } from "@/types/p4";

const connection: P4Connection = {
  root: "C:\\work\\client", port: "ssl:perforce.example.com:1666", user: "alice", client: "dev-pc", charset: "utf8", stream: null, server: "",
};
const integrate: P4IntegrateRequest = { source: "//depot/main/file.txt", target: "C:\\work\\client\\file.txt", range: null, changeId: "default" };

describe("Perforce operation preview approval", () => {
  it("localizes known application errors while preserving native command diagnostics", () => {
    expect(p4OperationErrorKey("The operation or workspace changed. Preview it again before applying.")).toBe("p4-operations.errors.stale");
    expect(p4OperationErrorKey("Perforce client error: fixture diagnostic")).toBeNull();
  });
  it("translates move, delete, and lock validation without rewriting server data or sentinels", () => {
    const messages = [
      "Choose a numbered changelist.", "Unsupported file action.", "Choose a file.",
      "Choose a pending changelist to lock or unlock files.", "Choose explicit opened files to lock or unlock.",
      "Resolve or revert this file's pending action before moving it.", "Choose a local workspace file.",
      "Choose a regular workspace file.", "Choose a versioned workspace file.", "Enter a relative destination inside this workspace.",
      "Enter a file name.", "The destination already exists. Choose another file name.",
      "Path is outside the workspace.", "Folder not found.",
    ];
    for (const message of messages) {
      expect(p4DisplayError(message, "en")).toBe(message);
      const translated = p4DisplayError(message, "zh-CN");
      expect(translated).not.toBe(message);
      expect(translated).not.toMatch(/^p4-operations\./);
      expect(translated).toBe(i18n.getResource("zh-CN", "translation", p4OperationErrorKey(message)!));
    }
    for (const message of ["Perforce login is required.", "p4 executable was not found. Choose one in Settings.", "//depot/main/file.txt#3 - locked by alice@dev-pc", "Folder not found. //depot/main"]) {
      expect(p4DisplayError(message, "zh-CN")).toBe(message);
    }
  });
  it("requires the same connection, operation, file scope, range, and pending changelist", () => {
    const gate = createP4PreviewGate();
    const key = p4OperationKey("integrate", connection, integrate);
    expect(gate.accepts(key, "fixture-digest")).toBe(false);
    expect(gate.complete(gate.begin(key), "fixture-digest")).toBe(true);
    expect(gate.accepts(key, "fixture-digest")).toBe(true);
    for (const request of [
      { ...integrate, source: "//depot/other/file.txt" },
      { ...integrate, target: "C:\\work\\client\\other.txt" },
      { ...integrate, range: { from: "1", to: "2" } },
      { ...integrate, changeId: "42" },
    ]) expect(gate.accepts(p4OperationKey("integrate", connection, request), "fixture-digest")).toBe(false);
    expect(gate.accepts(p4OperationKey("integrate", { ...connection, client: "other-pc" }, integrate), "fixture-digest")).toBe(false);
    expect(gate.accepts(key, "different-digest")).toBe(false);
    const undo: P4UndoRequest = { path: integrate.target, selector: { mode: "revision", revision: "2" }, changeId: "default" };
    expect(gate.accepts(p4OperationKey("undo", connection, undo), "fixture-digest")).toBe(false);
  });

  it("rejects stale preview completion after editing, retrying, or closing", () => {
    const gate = createP4PreviewGate();
    const first = gate.begin("first");
    gate.invalidate();
    expect(gate.complete(first, "old-digest")).toBe(false);
    const retry = gate.begin("retry");
    const latest = gate.begin("latest");
    expect(gate.complete(retry, "retry-digest")).toBe(false);
    expect(gate.complete(latest, "latest-digest")).toBe(true);
    gate.invalidate();
    expect(gate.accepts("latest", "latest-digest")).toBe(false);
    expect(gate.complete(latest, "late-digest")).toBe(false);
  });

  it("keeps literal file whitespace and every undo selector in the approved scope", () => {
    expect(p4OperationKey("integrate", connection, { ...integrate, target: "C:\\work\\client\\ file.txt" })).not.toBe(p4OperationKey("integrate", connection, integrate));
    const undo: P4UndoRequest = { path: integrate.target, selector: { mode: "revision", revision: "2" }, changeId: "42" };
    const key = p4OperationKey("undo", connection, undo);
    expect(p4OperationKey("undo", connection, { ...undo, selector: { mode: "revision", revision: "3" } })).not.toBe(key);
    expect(p4OperationKey("undo", connection, { ...undo, selector: { mode: "range", from: "1", to: "2" } })).not.toBe(key);
    expect(p4OperationKey("undo", connection, { ...undo, selector: { mode: "changelist", change: "42" } })).not.toBe(key);
  });
});
