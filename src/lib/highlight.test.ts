import { describe, expect, it } from "vitest";
import { highlightDiff } from "./highlight";

const classesOf = (ranges: { cls: string }[] | undefined) => (ranges ?? []).map((range) => range.cls);

describe("highlightDiff", () => {
  it("keeps a comment that spans context lines colored", () => {
    const ranges = highlightDiff(
      [
        { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
        { kind: "context", text: "/* starts here" },
        { kind: "context", text: "   ends here */" },
        { kind: "delete", text: "let a = 1;" },
        { kind: "add", text: "const a = 2;" },
      ],
      "typescript",
    );
    expect(ranges).not.toBeNull();
    expect(classesOf(ranges?.[2])).toEqual(["comment"]);
    expect(classesOf(ranges?.[3])).toContain("keyword");
    expect(classesOf(ranges?.[4])).toContain("number");
    expect(ranges?.[0]).toEqual([]);
  });

  it("gives up on unknown languages and very long lines", () => {
    expect(highlightDiff([{ kind: "add", text: "x" }], "nope")).toBeNull();
    expect(highlightDiff([{ kind: "add", text: "x".repeat(5000) }], "typescript")).toBeNull();
  });
});
