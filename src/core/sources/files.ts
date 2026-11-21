import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import type { FilesSource } from "../types.ts";
import { rank, type Excerpt, type Source } from "./source.ts";

/**
 * Local files as a data source: Kli cuts each file into excerpts (a Markdown section, some CSV rows with their
 * header, a JSON item) and ranks them by the query's words (BM25). No model and no index on disk: a file is cut again
 * only when it changed.
 */

/** Past these, a source stops: a folder of documents, not a disk. */
const MAX_FILES = 5000;
const MAX_BYTES = 5_000_000;
/** About how long an excerpt is, in characters. */
const PIECE = 1200;
/** CSV rows per excerpt, each with the header. */
const ROWS = 20;
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;

interface Piece {
  title: string;
  /** Lines (or rows) in the file: "12-30". */
  where: string;
  text: string;
}

const home = homedir();
const shown = (path: string) => (path.startsWith(home + "/") ? "~" + path.slice(home.length) : path);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The files a source's paths name: a file, everything in a folder, or what a glob matches. */
export function listFiles(paths: string[]): string[] {
  const found = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^~(?=\/|$)/, home);
    let base = path;
    let pattern = "**/*";
    if (existsSync(path) && statSync(path).isFile()) {
      found.add(path);
      continue;
    }
    if (!existsSync(path)) {
      // a glob: the folder before its first wildcard, and the rest
      const at = path.search(/[*?[{]/);
      if (at < 0) continue;
      base = path.slice(0, path.lastIndexOf("/", at)) || "/";
      pattern = path.slice(base.length + 1);
    }
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: base, absolute: true, onlyFiles: true, dot: false })) {
      if (SKIP.test(file)) continue;
      found.add(file);
      if (found.size >= MAX_FILES) return [...found];
    }
  }
  return [...found];
}

/** A Markdown or text file in excerpts: paragraphs up to about PIECE characters, a new one at each heading. */
function textPieces(name: string, text: string): Piece[] {
  const pieces: Piece[] = [];
  const lines = text.split("\n");
  let heading = "";
  let start = 0;
  let buf: string[] = [];
  const flush = () => {
    // the lines it says are the ones with text: blank lines around it do not count
    const first = buf.findIndex((l) => l.trim());
    if (first >= 0) {
      const last = buf.length - 1 - [...buf].reverse().findIndex((l) => l.trim());
      pieces.push({ title: heading ? `${name} · ${heading}` : name, where: `${start + first + 1}-${start + last + 1}`, text: buf.slice(first, last + 1).join("\n") });
    }
    buf = [];
  };
  lines.forEach((line, i) => {
    const h = /^#{1,6}\s+(.+)/.exec(line);
    const size = buf.reduce((t, l) => t + l.length + 1, 0);
    // a heading starts an excerpt; a long one ends at a blank line, and one with none (a list, code) at twice the size
    if (h || (size > PIECE && !line.trim()) || size > 2 * PIECE) {
      flush();
      start = i;
      if (h) heading = h[1]!.trim();
    }
    buf.push(line);
  });
  flush();
  return pieces;
}

/** A CSV in excerpts of ROWS rows, each with the header, so a model reads every value with its column. */
function csvPieces(name: string, text: string): Piece[] {
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim());
  if (!header) return [];
  const pieces: Piece[] = [];
  for (let i = 0; i < rows.length; i += ROWS) pieces.push({ title: name, where: `rows ${i + 1}-${Math.min(i + ROWS, rows.length)}`, text: [header, ...rows.slice(i, i + ROWS)].join("\n") });
  return pieces;
}

/** JSON in excerpts: the items of a list or the keys of an object, grouped up to about PIECE characters. */
function jsonPieces(name: string, text: string, lines: boolean): Piece[] {
  let items: [string, unknown][];
  try {
    if (lines) items = text.split("\n").filter((l) => l.trim()).map((l, i) => [String(i + 1), JSON.parse(l)]);
    else {
      const parsed = JSON.parse(text) as unknown;
      items = Array.isArray(parsed) ? parsed.map((v, i) => [String(i + 1), v]) : parsed && typeof parsed === "object" ? Object.entries(parsed) : [["", parsed]];
    }
  } catch {
    return textPieces(name, text);
  }
  const pieces: Piece[] = [];
  let group: [string, unknown][] = [];
  const flush = () => {
    if (!group.length) return;
    const keys = group.map(([k]) => k);
    pieces.push({ title: name, where: keys.length > 1 ? `${keys[0]}…${keys.at(-1)}` : keys[0]!, text: group.map(([k, v]) => (k && !/^\d+$/.test(k) ? `${k}: ` : "") + JSON.stringify(v, null, 1)).join("\n") });
    group = [];
  };
  for (const item of items) {
    group.push(item);
    if (JSON.stringify(group).length > PIECE) flush();
  }
  flush();
  return pieces;
}

function pieces(file: string, text: string): Piece[] {
  const name = basename(file);
  const ext = extname(file).toLowerCase();
  if (ext === ".csv" || ext === ".tsv") return csvPieces(name, text);
  if (ext === ".json") return jsonPieces(name, text, false);
  if (ext === ".jsonl" || ext === ".ndjson") return jsonPieces(name, text, true);
  return textPieces(name, text);
}

export class FilesSourceReader implements Source {
  /** Each file's excerpts, cut again only when the file changed. */
  private readonly cut = new Map<string, { mtime: number; pieces: Piece[] }>();

  constructor(
    readonly name: string,
    private readonly config: FilesSource,
  ) {}

  /** Every excerpt of the source's files as they are now: binary and huge files are left out. */
  private all(): { file: string; mtime: number; piece: Piece }[] {
    const out: { file: string; mtime: number; piece: Piece }[] = [];
    for (const file of listFiles(this.config.paths)) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.size > MAX_BYTES) continue;
      let had = this.cut.get(file);
      if (!had || had.mtime !== st.mtimeMs) {
        const bytes = readFileSync(file);
        had = { mtime: st.mtimeMs, pieces: bytes.subarray(0, 8000).includes(0) ? [] : pieces(file, bytes.toString("utf8")) };
        this.cut.set(file, had);
      }
      for (const piece of had.pieces) out.push({ file, mtime: st.mtimeMs, piece });
    }
    return out;
  }

  async search(query: string, top: number): Promise<Excerpt[]> {
    const all = this.all();
    // the title counts too: a file or a section named like the query is about it
    const scores = rank(query, all.map((a) => `${a.piece.title}\n${a.piece.text}`));
    return all
      .map((a, i) => ({ ...a, ...scores[i]! }))
      .filter((a) => a.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, top)
      .map((a) => ({
        source: this.name,
        title: a.piece.title,
        ref: `${shown(a.file)}:${a.piece.where}`,
        link: `file://${a.file}`,
        text: a.piece.text,
        score: Math.round(a.score * 100) / 100,
        relevance: Math.round(a.relevance * 100) / 100,
        modified: day(a.mtime),
      }));
  }
}

/** A file read whole (what a grounding node attaches every time): undefined when it cannot be read. */
export function readWhole(path: string): { ref: string; text: string; modified: string } | undefined {
  const abs = path.replace(/^~(?=\/|$)/, home);
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    return { ref: shown(abs), text: readFileSync(abs, "utf8"), modified: day(st.mtimeMs) };
  } catch {
    return undefined;
  }
}

