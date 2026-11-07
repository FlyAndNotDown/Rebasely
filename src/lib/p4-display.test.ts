import { afterEach, beforeEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { p4DisplayText } from "./p4-display";

const initialLanguage = i18n.language;
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(async () => { await i18n.changeLanguage(initialLanguage); });

it("preserves depot paths, unknown CLI output, and English status details", () => {
  for (const text of [
    "//depot/main/file.txt#3", "Unexpected server message: keep this intact.",
    "Opened by alice on dev-pc in changelist 42", "2 more users have this file open",
    "Merging //depot/main/file.txt#2 using base //depot/main/file.txt#1",
  ]) expect(p4DisplayText(text)).toBe(text);
});

it("translates known status grammar while preserving user, client, change, and revision values", async () => {
  await i18n.changeLanguage("zh-CN");
  const owner = p4DisplayText("Opened by alice on dev-pc in changelist 42");
  expect(owner).not.toMatch(/Opened by| in changelist |p4\./);
  for (const value of ["alice", "dev-pc", "42"]) expect(owner).toContain(value);
  const revision = p4DisplayText("Head revision 3");
  expect(revision).toContain("3");
  expect(revision).not.toContain("Head revision");
  const merge = p4DisplayText("Merging //depot/main/file.txt#2 using base //depot/main/file.txt#1");
  expect(merge).not.toMatch(/Merging|using base|p4\./);
  expect(merge).toContain("//depot/main/file.txt#2");
  expect(merge).toContain("//depot/main/file.txt#1");
});
