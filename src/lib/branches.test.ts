import { describe, expect, it } from "vitest";
import { groupRemoteBranches, shortRemoteName } from "./branches";

const branch = (name: string) => ({ name, isHead: false, isRemote: true, upstream: null });

describe("groupRemoteBranches", () => {
  it("puts origin first and default branches first within a remote", () => {
    const groups = groupRemoteBranches(
      [branch("upstream/zeta"), branch("origin/feature"), branch("origin/main"), branch("origin/develop")],
      ["backup"],
    );
    expect(groups.map(([remote, list]) => [remote, list.map((item) => item.name)])).toEqual([
      ["origin", ["origin/main", "origin/develop", "origin/feature"]],
      ["backup", []],
      ["upstream", ["upstream/zeta"]],
    ]);
  });

  it("strips the remote prefix only when it matches", () => {
    expect(shortRemoteName("origin/feat/x", "origin")).toBe("feat/x");
    expect(shortRemoteName("fork/main", "origin")).toBe("fork/main");
  });
});
