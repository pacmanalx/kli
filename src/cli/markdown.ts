/**
 * An answer's markdown as the terminal shows it, like Claude Code: headings, bold, italics, code, lists, quotes, rules
 * and tables with borders, every row already wrapped to the width. Models write markdown; shown raw, its marks (`**`,
 * backticks, the pipes of a table cut across lines) get in the way of reading.
 */

export interface Rendered {
  rows: string[];
  /** The leading rows more text cannot change: an answer still coming sends these to the scrollback. */
  settled: number;
}

const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const STRIKE = 8;
const CODE = 16;
const DIM = 32;

/** A piece of text and how it looks (the flags above). */
interface Span {
  text: string;
  style: number;
}

const width = (s: string) => Bun.stringWidth(s);

function sgr(style: number, text: string, color: boolean): string {
  if (!color || !style || !text) return text;
  const codes: string[] = [];
  if (style & BOLD) codes.push("1");
  if (style & DIM) codes.push("2");
  if (style & ITALIC) codes.push("3");
  if (style & UNDERLINE) codes.push("4");
  if (style & STRIKE) codes.push("9");
  // the terminal's own cyan reads on its own background, light or dark
  if (style & CODE) codes.push("36");
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

/** Pads a row that may carry colors to `w` columns, on the side its alignment asks. */
function align(row: string, w: number, how: "left" | "right" | "center"): string {
  const gap = Math.max(0, w - width(row));
  if (how === "right") return " ".repeat(gap) + row;
  if (how === "center") return " ".repeat(Math.floor(gap / 2)) + row + " ".repeat(Math.ceil(gap / 2));
  return row + " ".repeat(gap);
}

// ── inline: emphasis, code and links in one line ──

type Token =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; inner: string; url: string }
  | { kind: "delim"; ch: string; n: number; open: boolean; close: boolean; pair?: number; closes?: boolean };

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && PUNCTUATION.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let end = src.indexOf(fence, i + n);
      // the closing run must be exactly as long as the opening one
      while (end !== -1 && src[end + n] === "`") end = src.indexOf(fence, end + n + 1);
      if (end === -1) {
        text += fence;
        i += n;
        continue;
      }
      flush();
      const inner = src.slice(i + n, end);
      tokens.push({ kind: "code", text: /^ .*[^ ].* $/.test(inner) ? inner.slice(1, -1) : inner });
      i = end + n;
      continue;
    }
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const start = ch === "!" ? i + 1 : i;
      const close = src.indexOf("]", start + 1);
      const link = close !== -1 && src[close + 1] === "(" ? /^\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(close + 1)) : null;
      if (link) {
        flush();
        tokens.push({ kind: "link", inner: src.slice(start + 1, close), url: ch === "!" ? "" : link[1]! });
        i = close + 1 + link[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?|mailto):[^\s>]+)>/.exec(src.slice(i));
      if (auto) {
        flush();
        tokens.push({ kind: "link", inner: auto[1]!, url: "" });
        i += auto[0].length;
        continue;
      }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let n = 1;
      while (src[i + n] === ch) n++;
      const before = i > 0 ? src[i - 1]! : " ";
      const after = i + n < src.length ? src[i + n]! : " ";
      // `_` inside a word (snake_case) is a letter, not emphasis
      const open = !SPACE.test(after) && (ch !== "_" || !WORD.test(before));
      const close = !SPACE.test(before) && (ch !== "_" || !WORD.test(after));
      flush();
      tokens.push({ kind: "delim", ch, n, open, close });
      i += n;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return tokens;
}

/** What a pair of delimiters turns on: `*` italics, `**` bold, `***` both, `~~` a strike. */
function flag(ch: string, n: number): number {
  if (ch === "~") return n === 2 ? STRIKE : 0;
  return n === 1 ? ITALIC : n === 2 ? BOLD : n === 3 ? BOLD | ITALIC : 0;
}

/** One line's spans: emphasis pairs up like CommonMark, simplified; what does not pair stays as typed. */
function inline(src: string, base = 0): Span[] {
  const tokens = lex(src);
  const openers: number[] = [];
  for (const [i, t] of tokens.entries()) {
    if (t.kind !== "delim" || !flag(t.ch, t.n)) continue;
    if (t.close) {
      let k = openers.length - 1;
      while (k >= 0) {
        const o = tokens[openers[k]!] as Token & { kind: "delim" };
        if (o.ch === t.ch && o.n === t.n) break;
        k--;
      }
      if (k >= 0) {
        const at = openers[k]!;
        (tokens[at] as Token & { kind: "delim" }).pair = i;
        t.pair = at;
        t.closes = true;
        openers.length = k;
        continue;
      }
    }
    if (t.open) openers.push(i);
  }
  const spans: Span[] = [];
  const active: number[] = [];
  const style = () => active.reduce((s, f) => s | f, base);
  for (const t of tokens) {
    if (t.kind === "text") spans.push({ text: t.text, style: style() });
    else if (t.kind === "code") spans.push({ text: t.text, style: style() | CODE });
    else if (t.kind === "link") {
      spans.push(...inline(t.inner, style()));
      if (t.url && t.url !== t.inner && t.url !== `mailto:${t.inner}`) spans.push({ text: ` (${t.url})`, style: style() | DIM });
    } else if (t.pair === undefined) spans.push({ text: t.ch.repeat(t.n), style: style() });
    else if (t.closes) active.splice(active.lastIndexOf(flag(t.ch, t.n)), 1);
    else active.push(flag(t.ch, t.n));
  }
  return spans;
}

const plain = (spans: Span[]) => spans.map((s) => s.text).join("");

// ── wrapping spans into rows ──

/**
 * Word wrap of styled spans to `w` columns; the first row starts with `first` and the others with `rest` (a list
 * item's text stays under its own text). A word longer than a row is cut.
 */
function wrapSpans(spans: Span[], w: number, color: boolean, first = "", rest = first): string[] {
  const pieces: Span[] = [];
  for (const s of spans) for (const part of s.text.match(/\s+|\S+/g) ?? []) pieces.push({ text: part, style: s.style });
  const rows: string[] = [];
  let line: Span[] = [];
  let used = 0;
  const room = () => Math.max(1, w - width(rows.length ? rest : first));
  const flush = () => {
    while (line.length && /^\s+$/.test(line.at(-1)!.text)) line.pop();
    let out = "";
    let k = 0;
    while (k < line.length) {
      let j = k;
      let text = "";
      while (j < line.length && line[j]!.style === line[k]!.style) text += line[j++]!.text;
      out += sgr(line[k]!.style, text, color);
      k = j;
    }
    rows.push((rows.length ? rest : first) + out);
    line = [];
    used = 0;
  };
  for (const p of pieces) {
    const pw = width(p.text);
    if (/^\s+$/.test(p.text)) {
      if (!line.length) continue;
      if (used + pw <= room()) {
        line.push(p);
        used += pw;
      } else flush();
      continue;
    }
    if (used + pw <= room()) {
      line.push(p);
      used += pw;
      continue;
    }
    if (line.length) flush();
    let left = p.text;
    while (width(left) > room()) {
      let cut = "";
      for (const ch of left) {
        if (width(cut + ch) > room()) break;
        cut += ch;
      }
      if (!cut) cut = [...left][0]!;
      line.push({ text: cut, style: p.style });
      flush();
      left = left.slice(cut.length);
    }
    if (left) {
      line.push({ text: left, style: p.style });
      used = width(left);
    }
  }
  if (line.length || !rows.length) flush();
  return rows;
}

// ── tables ──

/** A table row's cells: the pipes inside code or escaped with `\` belong to the cell. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cell += ch;
    } else if (ch === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

const isRow = (line: string) => line.trimStart().startsWith("|");
const isRule = (line: string) => isRow(line) && cells(line).every((c) => /^:?-+:?$/.test(c));

/**
 * The narrowest a column gets before the table gives up on columns: its longest word, so words are not cut, but never
 * less than `MIN_CELL` nor more than `MAX_WORD` (a long address may be cut).
 */
const MIN_CELL = 8;
const MAX_WORD = 20;

/**
 * A table with borders, its columns shrunk to the width (the widest first) and the cells wrapped inside them; when
 * not even that fits, one record per row, each cell under its column's name.
 */
function tableRows(lines: string[], w: number, color: boolean): string[] {
  const head = cells(lines[0]!);
  const how = cells(lines[1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left") as "left" | "right" | "center");
  const n = head.length;
  const body = lines.slice(2).map((l) => {
    const c = cells(l);
    return Array.from({ length: n }, (_, k) => c[k] ?? "");
  });
  // a cell's paragraphs: models break lines inside a cell with <br>
  const parse = (cell: string, base = 0) => cell.split(/<br\s*\/?>/i).map((p) => inline(p.trim(), base));
  const header = head.map((c) => parse(c, BOLD));
  const grid = body.map((r) => r.map((c) => parse(c)));
  const natural = Array.from({ length: n }, (_, k) => Math.max(1, ...[header, ...grid].map((r) => Math.max(0, ...(r[k] ?? []).map((p) => width(plain(p)))))));
  const room = w - (3 * n + 1);
  const cols = natural.slice();
  const longest = Array.from({ length: n }, (_, k) => Math.max(1, ...[header, ...grid].flatMap((r) => (r[k] ?? []).flatMap((p) => plain(p).split(/\s+/).map(width)))));
  const floor = natural.map((x, k) => Math.min(x, Math.max(MIN_CELL, Math.min(longest[k]!, MAX_WORD))));
  let fits = room >= floor.reduce((a, b) => a + b, 0);
  while (fits && cols.reduce((a, b) => a + b, 0) > room) {
    let widest = -1;
    for (let k = 0; k < n; k++) if (cols[k]! > floor[k]! && (widest < 0 || cols[k]! > cols[widest]!)) widest = k;
    if (widest < 0) fits = false;
    else cols[widest]!--;
  }
  const border = (s: string) => sgr(DIM, s, color);
  if (!fits) {
    const rows: string[] = [];
    for (const [r, row] of grid.entries()) {
      if (r) rows.push("");
      for (let k = 0; k < n; k++) {
        const name = { text: `${plain(header[k]!.flat())}: `, style: BOLD };
        const [firstPart = [], ...more] = row[k]!;
        rows.push(...wrapSpans([name, ...firstPart], w, color, "", "  "));
        for (const p of more) rows.push(...wrapSpans(p, w, color, "  "));
      }
    }
    return rows;
  }
  const line = (l: string, m: string, r: string) => border(l + cols.map((c) => "─".repeat(c + 2)).join(m) + r);
  const rowLines = (row: Span[][][]) => {
    const wrapped = row.map((paragraphs, k) => paragraphs.flatMap((p) => wrapSpans(p, cols[k]!, color)));
    const height = Math.max(...wrapped.map((c) => c.length));
    return Array.from({ length: height }, (_, y) => border("│ ") + wrapped.map((c, k) => align(c[y] ?? "", cols[k]!, how[k] ?? "left")).join(border(" │ ")) + border(" │"));
  };
  const bodies = grid.map(rowLines);
  // a row of several lines needs a line under it, or the rows run into each other
  const tall = bodies.some((b) => b.length > 1);
  const rows = [line("┌", "┬", "┐"), ...rowLines(header), line("├", "┼", "┤")];
  for (const [k, b] of bodies.entries()) {
    if (k && tall) rows.push(line("├", "┼", "┤"));
    rows.push(...b);
  }
  rows.push(line("└", "┴", "┘"));
  return rows;
}

// ── blocks ──

/** One block's rows, the source line it ends on, and whether more lines can still join it (a table). */
interface Block {
  rows: string[];
  last: number;
  grows?: boolean;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}((?:>\s?)+)(.*)$/;

/**
 * Markdown to terminal rows at `w` columns. Each source line keeps its own rows (models do not hard-wrap), so a line
 * that is done looks the same however much text comes after it; only the last line, still being written, and a
 * table, whose columns depend on all its rows, can change.
 */
export function markdown(text: string, w: number, color: boolean): Rendered {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  // the last line is still being written; empty, it shows nothing
  if (lines.at(-1) === "") lines.pop();
  const partial = text.endsWith("\n") ? lines.length : lines.length - 1;
  const blocks: Block[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const at = (rows: string[], last = i, grows = false) => blocks.push({ rows, last, grows });
    if (fence) {
      const close = FENCE.exec(l);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && !l.trim().slice(close[1]!.length).trim()) {
        fence = undefined;
        at([]);
      } else at(codeRows(l, w, color));
      continue;
    }
    const open = FENCE.exec(l);
    if (open && !(open[1]![0] === "`" && l.slice(l.indexOf(open[1]!) + open[1]!.length).includes("`"))) {
      fence = open[1]!;
      at([]);
      continue;
    }
    if (!l.trim()) {
      at([""]);
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      let end = i + 2;
      while (end < lines.length && isRow(lines[end]!)) end++;
      at(tableRows(lines.slice(i, end), w, color), end - 1, true);
      i = end - 1;
      continue;
    }
    const heading = HEADING.exec(l);
    if (heading) {
      at(wrapSpans(inline(heading[2]!, heading[1]!.length === 1 ? BOLD | UNDERLINE : BOLD), w, color));
      continue;
    }
    if (RULE.test(l)) {
      at([sgr(DIM, "─".repeat(Math.max(1, w)), color)]);
      continue;
    }
    const quote = QUOTE.exec(l);
    if (quote) {
      // not the │ of a table or of the stack's columns
      const bar = sgr(DIM, "▎ ".repeat(quote[1]!.replace(/\s/g, "").length), color);
      at(wrapSpans(inline(quote[2]!, ITALIC), w, color, bar));
      continue;
    }
    const item = ITEM.exec(l);
    if (item) {
      const indent = " ".repeat(Math.min(item[1]!.length, Math.floor(w / 2)));
      const mark = /\d/.test(item[2]!) ? item[2]! : "-";
      at(wrapSpans(inline(item[3]!), w, color, `${indent}${mark} `, indent + " ".repeat(width(mark) + 1)));
      continue;
    }
    // a row that may yet become a table's header: its rule has not come
    const indent = " ".repeat(Math.min(l.length - l.trimStart().length, Math.floor(w / 2)));
    at(wrapSpans(inline(l.trim()), w, color, indent), i, isRow(l));
  }
  const rows: string[] = [];
  let settled = 0;
  let done = true;
  for (const b of blocks) {
    // a block is done when its lines are done and nothing after it can still join it
    if (done && (b.last >= partial || (b.grows && b.last >= partial - 1))) done = false;
    rows.push(...b.rows);
    if (done) settled = rows.length;
  }
  return { rows, settled };
}

/** A code line: indented, in the code color, cut (not word-wrapped) when longer than the row. */
function codeRows(line: string, w: number, color: boolean): string[] {
  const room = Math.max(1, w - 2);
  const rows: string[] = [];
  let left = line;
  do {
    let cut = "";
    for (const ch of left) {
      if (width(cut + ch) > room) break;
      cut += ch;
    }
    if (!cut && left) cut = [...left][0]!;
    rows.push("  " + sgr(CODE, cut.trimEnd(), color));
    left = left.slice(cut.length);
  } while (left);
  return rows;
}
