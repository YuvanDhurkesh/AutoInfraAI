/**
 * Line diffs for revision history (Terraform files are small -- a few hundred
 * lines -- so a plain LCS table is fast enough and keeps this dependency-free).
 */

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: "added" | "removed" | "modified";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/** Above this many LCS cells, show the file as fully replaced instead. */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: DiffLine[] = [];

  if (a.length * b.length > MAX_CELLS) {
    a.forEach((text, i) => out.push({ kind: "del", text, oldNo: i + 1 }));
    b.forEach((text, j) => out.push({ kind: "add", text, newNo: j + 1 }));
    return out;
  }

  // lcs[i][j] = LCS length of a[i..] and b[j..], flattened.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push({ kind: "del", text: a[i]!, oldNo: i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]!, newNo: j + 1 });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: "del", text: a[i]!, oldNo: i + 1 });
  for (; j < b.length; j++) out.push({ kind: "add", text: b[j]!, newNo: j + 1 });
  return out;
}

/** Groups changed lines into hunks with `context` unchanged lines around them. */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  // Merge each change's [idx - context, idx + context] window with its neighbours.
  const ranges: Array<[number, number]> = [];
  lines.forEach((line, idx) => {
    if (line.kind === "same") return;
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  return ranges.map(([start, end]) => ({
    oldStart: nextNo(lines, start, "oldNo"),
    newStart: nextNo(lines, start, "newNo"),
    lines: lines.slice(start, end + 1),
  }));
}

function nextNo(lines: DiffLine[], from: number, key: "oldNo" | "newNo"): number {
  for (let k = from; k < lines.length; k++) {
    const n = lines[k]![key];
    if (n !== undefined) return n;
  }
  for (let k = from - 1; k >= 0; k--) {
    const n = lines[k]![key];
    if (n !== undefined) return n + 1;
  }
  return 1;
}

/** Per-file diff of two file sets; unchanged files are omitted. */
export function diffFiles(
  before: ReadonlyArray<{ path: string; content: string }>,
  after: ReadonlyArray<{ path: string; content: string }>,
): FileDiff[] {
  const oldByPath = new Map(before.map((f) => [f.path, f.content]));
  const newByPath = new Map(after.map((f) => [f.path, f.content]));
  const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort();
  const result: FileDiff[] = [];
  for (const path of paths) {
    const oldContent = oldByPath.get(path);
    const newContent = newByPath.get(path);
    if (oldContent === newContent) continue;
    const lines = diffLines(oldContent ?? "", newContent ?? "");
    result.push({
      path,
      status:
        oldContent === undefined ? "added" : newContent === undefined ? "removed" : "modified",
      additions: lines.filter((l) => l.kind === "add").length,
      deletions: lines.filter((l) => l.kind === "del").length,
      hunks: toHunks(lines),
    });
  }
  return result;
}
