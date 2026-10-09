import { describe, expect, it } from "vitest";
import { applyConflictChoice, conflictHunks, conflictSegments, replaceRange, setConflictSide, visibleBody } from "./conflict-text";

const simple = ["keep\n", "<<<<<<< HEAD\n", "ours\n", "=======\n", "theirs\n", ">>>>>>> branch\n", "tail\n"].join("");

const diff3 = [
  "<<<<<<< HEAD\n",
  "ours\n",
  "||||||| parent\n",
  "base\n",
  "=======\n",
  "theirs\n",
  ">>>>>>> branch\n",
].join("");

describe("conflictHunks", () => {
  it("reads a two-sided hunk and the text around it", () => {
    const [hunk] = conflictHunks(simple);
    expect(hunk).toMatchObject({ ours: "ours\n", theirs: "theirs\n", base: "", hasBase: false });
    expect(simple.slice(hunk.start, hunk.end)).toBe("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
  });

  it("keeps the diff3 base out of ours and theirs", () => {
    expect(conflictHunks(diff3)[0]).toMatchObject({
      ours: "ours\n",
      theirs: "theirs\n",
      base: "base\n",
      hasBase: true,
    });
  });

  it("ignores markers that are not at the start of a line and stops on an unclosed hunk", () => {
    const marked = "note <<<<<<< not a marker\n" + simple;
    expect(conflictHunks(marked)).toHaveLength(1);
    expect(conflictHunks(marked)[0].ours).toBe("ours\n");
    expect(conflictHunks("<<<<<<< HEAD\nours\n=======\ntheirs\n")).toEqual([]);
  });

  it("splits the file into text and conflict segments", () => {
    const segments = conflictSegments(simple);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "conflict", "text"]);
    expect(segments[0]).toMatchObject({ text: "keep\n" });
    expect(segments[2]).toMatchObject({ text: "tail\n" });
    expect(conflictSegments("")).toEqual([{ kind: "text", start: 0, end: 0, text: "" }]);
  });
});

describe("applyConflictChoice", () => {
  it("replaces a hunk with one side, both, or nothing", () => {
    expect(applyConflictChoice(simple, 0, "ours")).toBe("keep\nours\ntail\n");
    expect(applyConflictChoice(simple, 0, "theirs")).toBe("keep\ntheirs\ntail\n");
    expect(applyConflictChoice(simple, 0, "none")).toBe("keep\ntail\n");
    expect(applyConflictChoice(simple, 0, "both")).toBe("keep\nours\ntheirs\ntail\n");
  });

  it("uses the only non-empty side for both, and leaves an unknown hunk alone", () => {
    const emptyOurs = "<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> branch\n";
    expect(applyConflictChoice(emptyOurs, 0, "both")).toBe("theirs\n");
    expect(applyConflictChoice(simple, 3, "ours")).toBe(simple);
  });

  it("resolves a later hunk without disturbing the earlier one", () => {
    const second = simple + "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n";
    expect(applyConflictChoice(second, 1, "theirs")).toBe(simple + "right\n");
  });
});

describe("setConflictSide", () => {
  it("rewrites one side and keeps a trailing newline", () => {
    const next = setConflictSide(diff3, 0, "ours", "edited");
    const [hunk] = conflictHunks(next);
    expect(hunk.ours).toBe("edited\n");
    expect(hunk.theirs).toBe("theirs\n");
    expect(hunk.base).toBe("base\n");
  });

  it("clears a side when the new value is empty", () => {
    const next = setConflictSide(simple, 0, "theirs", "");
    expect(conflictHunks(next)[0].theirs).toBe("");
    expect(setConflictSide(simple, 4, "ours", "nope")).toBe(simple);
  });
});

describe("text helpers", () => {
  it("replaces a range and hides one trailing newline", () => {
    expect(replaceRange("abcdef", 2, 4, "XY")).toBe("abXYef");
    expect(visibleBody("ours\n")).toBe("ours");
    expect(visibleBody("ours")).toBe("ours");
  });
});
