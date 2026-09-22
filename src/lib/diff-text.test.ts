import { diffLineSpans } from "./diff-text";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
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

trailingSpace();
lineEndingHighlightsFollowingText();
returnInsideLineHighlightsTail();
insertedReturnHighlightsFollowingCode();
tabTypedOnALineStaysHighlighted();
sharedIndentStaysPlain();
console.log("diff-text tests passed");
