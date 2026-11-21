/** One line of a diff: kept (" "), removed ("-") or added ("+"), with its line number in the new file. */
export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
  /** Line number in the old file ("-" and " ") or in the new one ("+"). */
  line: number;
}

/**
 * The lines that change from `before` to `after`, with `context` unchanged lines around each change (a longest
 * common subsequence; big files fall back to "everything removed, everything added").
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  // the line break that ends a file is not a line of its own
  const split = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(before);
  const b = split(after);
  // trim what is the same at both ends, so only the middle needs the table
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const all: DiffLine[] = a.slice(0, start).map((text, i) => ({ op: " ", text, line: i + 1 }));
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((text, i) => all.push({ op: "-", text, line: start + i + 1 }));
    midB.forEach((text, i) => all.push({ op: "+", text, line: start + i + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        all.push({ op: " ", text: midA[i]!, line: start + i + 1 });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        // what goes out before what comes in
        all.push({ op: "-", text: midA[i]!, line: start + i + 1 });
        i++;
      } else {
        all.push({ op: "+", text: midB[j]!, line: start + j + 1 });
        j++;
      }
    }
  }
  a.slice(endA).forEach((text, k) => all.push({ op: " ", text, line: endA + k + 1 }));
  // keep only the changes and their context
  const keep = new Set<number>();
  all.forEach((d, k) => {
    if (d.op === " ") return;
    for (let c = Math.max(0, k - context); c <= Math.min(all.length - 1, k + context); c++) keep.add(c);
  });
  return all.filter((_, k) => keep.has(k));
}

/** How many lines a diff adds and removes. */
export function diffCount(diff: DiffLine[]): { added: number; removed: number } {
  return { added: diff.filter((d) => d.op === "+").length, removed: diff.filter((d) => d.op === "-").length };
}
