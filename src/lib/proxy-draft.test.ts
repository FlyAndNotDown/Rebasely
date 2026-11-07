import { describe, expect, it } from "vitest";
import type { HttpProxy } from "@/lib/network";
import {
  acceptProxyDraft,
  createProxyDraft,
  editProxyDraft,
  proxyDraftChanged,
  reconcileProxyDraft,
} from "./proxy-draft";

const system: HttpProxy = { mode: "system", url: "" };
const direct: HttpProxy = { mode: "none", url: "" };
const first: HttpProxy = { mode: "manual", url: "http://proxy.example.com:8080/" };
const second: HttpProxy = { mode: "manual", url: "socks5://proxy.example.com:1080" };

describe("proxy settings draft", () => {
  it("follows a late preferences load or a pending save after the pane remounts", () => {
    const mounted = createProxyDraft(system);
    const updated = reconcileProxyDraft(mounted, first);
    expect(updated.value).toEqual(first);
    expect(proxyDraftChanged(updated)).toBe(false);
    expect(reconcileProxyDraft(updated, { ...first })).toBe(updated);
  });

  it("retains local input when an older persistence result arrives", () => {
    const entered = editProxyDraft(createProxyDraft(system), second);
    const updated = reconcileProxyDraft(entered, first);
    expect(updated.value).toEqual(second);
    expect(updated.saved).toEqual(first);
    expect(proxyDraftChanged(updated)).toBe(true);
    expect(reconcileProxyDraft(updated, direct).value).toEqual(second);
    expect(entered.observed).toEqual(system);
  });

  it("follows saved values again after the user returns to the saved mode", () => {
    const entered = editProxyDraft(createProxyDraft(system), second);
    const reverted = editProxyDraft(entered, { mode: "system" });
    expect(proxyDraftChanged(reverted)).toBe(false);
    const updated = reconcileProxyDraft(reverted, direct);
    expect(updated.value).toEqual(direct);
    expect(proxyDraftChanged(updated)).toBe(false);
  });

  it("clears dirty state on success without reverting to lagging parent props", () => {
    const entered = editProxyDraft(createProxyDraft(system), { ...first, url: "http://proxy.example.com:8080" });
    const saved = acceptProxyDraft(entered, first);
    expect(saved.value).toEqual(first);
    expect(proxyDraftChanged(saved)).toBe(false);
    expect(reconcileProxyDraft(saved, system)).toBe(saved);
    const caughtUp = reconcileProxyDraft(saved, first);
    expect(caughtUp.value).toEqual(first);
    expect(proxyDraftChanged(caughtUp)).toBe(false);
  });

  it("preserves new edits when the successful save's parent snapshot arrives later", () => {
    const saved = acceptProxyDraft(editProxyDraft(createProxyDraft(system), first), first);
    const entered = editProxyDraft(saved, second);
    const caughtUp = reconcileProxyDraft(entered, first);
    expect(caughtUp.value).toEqual(second);
    expect(proxyDraftChanged(caughtUp)).toBe(true);
  });

  it("keeps entered bytes when an incoming saved value already matches the draft", () => {
    const raw = { ...first, url: ` ${first.url} ` };
    const entered = editProxyDraft(createProxyDraft(system), raw);
    const updated = reconcileProxyDraft(entered, first);
    expect(updated.value.url).toBe(raw.url);
    expect(proxyDraftChanged(updated)).toBe(false);
  });
});
