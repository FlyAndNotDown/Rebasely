import { describe, expect, it } from "vitest";
import { diffLineSpans, hunkLabel, languageFor, styleSpans, textColumns } from "./diff-text";

function assert(condition: boolean, message: string) {
  expect(condition, message).toBe(true);
}

function trailingSpace() {
  const spans = diffLineSpans([
    { kind: "delete", content: "    PyUtil::CollectGarbage(); " },
    { kind: "add", content: "    PyUtil::CollectGarbage();" },
  ]);
  const removed = spans[0].filter((span) => span.changed).map((span) => span.text).join("");
  assert(removed === " ", "the extra space is the only highlighted change");
  assert(
    spans[1].every((span) => !span.changed),
    "the line without the space stays unmarked",
  );
}

function lineEndingHighlightsFollowingText() {
  const spans = diffLineSpans([
    { kind: "delete", content: "line\r" },
    { kind: "add", content: "line" },
    { kind: "context", content: "next" },
  ]);
  assert(spans.every((row) => row.every((span) => !span.text.includes("\r"))), "CR is not drawn");
  assert(spans[0].every((span) => !span.changed), "text before a trailing CR stays plain");
  assert(
    spans[2].some((span) => span.changed && span.text === "next" && span.tone === "delete"),
    "the line after a trailing CR is highlighted",
  );
}

function returnInsideLineHighlightsTail() {
  const spans = diffLineSpans([
    { kind: "delete", content: "foo\rbar" },
    { kind: "add", content: "foobar" },
  ]);
  assert(spans[0].some((span) => !span.changed && span.text === "foo"), "text before an inner CR stays plain");
  assert(spans[0].some((span) => span.changed && span.text === "bar"), "text after an inner CR is highlighted");
  assert(spans[0].every((span) => !span.text.includes("\r")), "an inner CR is not drawn");
}

function insertedReturnHighlightsFollowingCode() {
  const spans = diffLineSpans([
    { kind: "context", content: "\tif (!PythonFileDataSource)" },
    { kind: "add", content: "\t" },
    { kind: "context", content: "\t{" },
  ]);
  assert(spans[1].every((span) => !span.changed), "an inserted blank line is not a tab block");
  assert(
    spans[2].some((span) => span.changed && span.text === "{" && span.tone === "add"),
    "the code after an inserted line is highlighted",
  );
  assert(spans[2].some((span) => !span.changed && span.text === "\t"), "indent before that code stays plain");
}

function tabTypedOnALineStaysHighlighted() {
  const spans = diffLineSpans([
    { kind: "delete", content: "" },
    { kind: "add", content: "\t" },
    { kind: "context", content: "\tif (!PythonFileDataSource)" },
  ]);
  assert(spans[1].some((span) => span.changed && span.text === "\t"), "a tab on an edited line stays highlighted");
  assert(spans[2].every((span) => !span.changed), "the following line is not marked for a tab edit");
}

function sharedIndentStaysPlain() {
  const spans = diffLineSpans([
    { kind: "delete", content: "    alpha" },
    { kind: "add", content: "    beta" },
  ]);
  assert(spans[0][0].text === "    " && !spans[0][0].changed, "shared indent is not marked");
  assert(spans[0].some((span) => span.changed && span.text === "alph"), "the word change is marked");
}

describe("diffLineSpans", () => {
  it("highlights only a trailing space", trailingSpace);
  it("highlights the text after a trailing CR", lineEndingHighlightsFollowingText);
  it("highlights the tail after an inner CR", returnInsideLineHighlightsTail);
  it("highlights code after an inserted line", insertedReturnHighlightsFollowingCode);
  it("keeps a typed tab highlighted", tabTypedOnALineStaysHighlighted);
  it("keeps shared indent plain", sharedIndentStaysPlain);
});

describe("styleSpans", () => {
  it("cuts change spans at token boundaries and keeps both marks", () => {
    const styled = styleSpans(
      [
        { text: "let x", changed: false },
        { text: " = 1", changed: true },
      ],
      [
        { start: 0, end: 3, cls: "keyword" },
        { start: 8, end: 9, cls: "number" },
      ],
    );
    expect(styled.map((span) => [span.text, span.changed, span.cls])).toEqual([
      ["let", false, "keyword"],
      [" x", false, null],
      [" = ", true, null],
      ["1", true, "number"],
    ]);
  });

  it("passes spans through when there are no tokens", () => {
    expect(styleSpans([{ text: "a", changed: true }], null)).toEqual([{ text: "a", changed: true, cls: null }]);
  });
});

describe("hunkLabel", () => {
  it("drops the git range and keeps the function heading", () => {
    expect(hunkLabel("@@ -225,6 +225,9 @@ float3 ReflectionEnvironment(FGBufferData GBuffer)")).toBe(
      "float3 ReflectionEnvironment(FGBufferData GBuffer)",
    );
    expect(hunkLabel("@@ -1 +1,4 @@\r")).toBe("");
    expect(hunkLabel("@@ -0,0 +1,3 @@")).toBe("");
  });

  it("leaves a line that is not a hunk header unchanged", () => {
    expect(hunkLabel("@@ not a header")).toBe("@@ not a header");
  });
});

describe("languageFor", () => {
  it("maps extensions and well-known file names", () => {
    expect(languageFor("Source/Game/Actor.h")).toBe("cpp");
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("Shaders/Common.ush")).toBe("hlsl");
    expect(languageFor("docker/Dockerfile")).toBe("docker");
    expect(languageFor("Content/Level.umap")).toBeNull();
    expect(languageFor("LICENSE")).toBeNull();
  });
});

describe("textColumns", () => {
  it("counts plain text one column per character", () => {
    expect(textColumns("abc")).toBe(3);
  });
  it("expands tabs to the next stop of four", () => {
    expect(textColumns("\tx")).toBe(5);
    expect(textColumns("ab\tx")).toBe(5);
  });
  it("counts wide characters as two columns and ignores CR", () => {
    expect(textColumns("ＡＢa\r")).toBe(5);
  });
});
