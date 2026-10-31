import { describe, expect, it } from "vitest";
import { diffFiles, diffLines, toHunks } from "./diff.js";

const render = (before: string, after: string) =>
  diffLines(before, after).map(
    (l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`,
  );

describe("diffLines", () => {
  it("marks a changed line as a delete + add and keeps the rest", () => {
    expect(render("a\nb\nc\n", "a\nB\nc\n")).toEqual([" a", "-b", "+B", " c"]);
  });

  it("handles empty sides and CRLF", () => {
    expect(render("", "x\ny")).toEqual(["+x", "+y"]);
    expect(render("x\r\ny\r\n", "")).toEqual(["-x", "-y"]);
    expect(render("x\r\ny\r\n", "x\ny\n")).toEqual([" x", " y"]);
  });

  it("numbers lines on each side", () => {
    const lines = diffLines("a\nb", "a\nx\nb");
    expect(lines.find((l) => l.kind === "add")).toEqual({ kind: "add", text: "x", newNo: 2 });
    expect(lines.at(-1)).toEqual({ kind: "same", text: "b", oldNo: 2, newNo: 3 });
  });
});

describe("toHunks", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it("keeps 3 lines of context and splits distant changes into separate hunks", () => {
    const before = big(40);
    const after = [...before];
    after[4] = "changed 5";
    after[34] = "changed 35";
    const hunks = toHunks(diffLines(before.join("\n"), after.join("\n")));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.oldStart).toBe(2);
    expect(hunks[0]!.lines.map((l) => l.text)).toEqual([
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "changed 5",
      "line 6",
      "line 7",
      "line 8",
    ]);
    expect(hunks[1]!.newStart).toBe(32);
  });

  it("merges changes whose context overlaps", () => {
    const before = big(20);
    const after = [...before];
    after[5] = "x";
    after[9] = "y";
    expect(toHunks(diffLines(before.join("\n"), after.join("\n")))).toHaveLength(1);
  });

  it("returns nothing for identical input", () => {
    expect(toHunks(diffLines("a\nb", "a\nb"))).toEqual([]);
  });
});

describe("diffFiles", () => {
  it("reports added, removed and modified files, skipping unchanged ones", () => {
    const result = diffFiles(
      [
        { path: "main.tf", content: "a\nb\n" },
        { path: "old.tf", content: "gone\n" },
        { path: "same.tf", content: "s\n" },
      ],
      [
        { path: "main.tf", content: "a\nc\n" },
        { path: "new.tf", content: "n1\nn2\n" },
        { path: "same.tf", content: "s\n" },
      ],
    );
    expect(result.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["main.tf", "modified", 1, 1],
      ["new.tf", "added", 2, 0],
      ["old.tf", "removed", 0, 1],
    ]);
  });
});
