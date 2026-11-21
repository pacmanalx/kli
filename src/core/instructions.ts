import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { KLI_DIR } from "./config.ts";

/**
 * The project's instructions: the files other coding agents already read, AGENTS.md (OpenCode, Codex, Antigravity…)
 * and CLAUDE.md (Claude Code), plus CLAUDE.local.md (the person's own, kept out of Git: Claude Code reads it after
 * CLAUDE.md), so a project that has them works the same in Kli. They are read from ~/.kli (the
 * person's own), then from every folder from the top of the disk down to the working folder (the closer, the later,
 * so they win); a folder below it gets its files when the model first reads something there. `@path` brings in
 * another file, as in Claude Code.
 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"];

export interface InstructionFile {
  /** Absolute path. */
  path: string;
  /** For people and for the model: relative to the working folder, or with ~. */
  shown: string;
  content: string;
  /** Brought in by an `@path` in another file. */
  imported?: boolean;
}

/** Bigger files are cut: they would crowd the conversation out. */
const MAX_CHARS = 40_000;
/** How deep `@path` imports may go. */
const MAX_DEPTH = 5;

/** Reads instruction files and their imports, once each (a symlink or a copy of one already read is skipped). */
export class InstructionReader {
  private readonly seen = new Set<string>();
  private readonly contents = new Set<string>();

  constructor(
    readonly root: string,
    private readonly home = homedir(),
  ) {}

  /** For the screen and the model: "AGENTS.md", "src/AGENTS.md", "~/dev/AGENTS.md". */
  shown(path: string): string {
    const rel = relative(this.root, path);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
    return path.startsWith(this.home + "/") ? "~" + path.slice(this.home.length) : path;
  }

  /** The files in one folder that were not read yet, each followed by what it imports. */
  folder(dir: string): InstructionFile[] {
    return INSTRUCTION_FILES.flatMap((name) => this.file(join(dir, name), 0, false));
  }

  private file(path: string, depth: number, imported: boolean): InstructionFile[] {
    let real: string;
    try {
      if (!statSync(path).isFile()) return [];
      real = realpathSync(path);
    } catch {
      return [];
    }
    if (this.seen.has(real)) return [];
    this.seen.add(real);
    let content = readFileSync(path, "utf8").trim();
    if (content.length > MAX_CHARS) content = `${content.slice(0, MAX_CHARS)}\n… (cut: the file has ${content.length} characters, only the first ${MAX_CHARS} are here)`;
    const imports = depth < MAX_DEPTH ? importsOf(content, dirname(path), this.home) : [];
    const brought = imports.flatMap((p) => this.file(p, depth + 1, true));
    // a file that only brings in others (CLAUDE.md with "@AGENTS.md") adds nothing of its own; nor does a copy
    const own = stripImports(content, imports, dirname(path), this.home).trim();
    if (!own || this.contents.has(content)) return brought;
    this.contents.add(content);
    return [{ path, shown: this.shown(path), content, ...(imported && { imported }) }, ...brought];
  }
}

/** The files read when a session starts: the person's own in ~/.kli, then each folder from the top down to `root`. */
export function loadInstructions(reader: InstructionReader, userDir = KLI_DIR): InstructionFile[] {
  const folders: string[] = [];
  for (let dir = resolve(reader.root); ; dir = dirname(dir)) {
    folders.unshift(dir);
    if (dir === parse(dir).root) break;
  }
  return [userDir, ...folders].flatMap((dir) => reader.folder(dir));
}

/** The folders between `root` (not included) and the one holding `file`, top first; none when it is outside. */
export function foldersBelow(root: string, file: string): string[] {
  const rel = relative(root, dirname(file));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  const parts = rel.split("/");
  return parts.map((_, i) => join(root, ...parts.slice(0, i + 1)));
}

/** The instructions as the model gets them, after the environment in the system prompt. */
export function instructionsPrompt(files: InstructionFile[]): string {
  if (!files.length) return "";
  return [
    "The person and the project left instructions in the files below (AGENTS.md, CLAUDE.md, CLAUDE.local.md). Follow them: they come before your defaults, and a later file wins over an earlier one.",
    ...files.map((f) => `<instructions file="${f.shown}">\n${f.content}\n</instructions>`),
  ].join("\n\n");
}

const REFERENCE = /(^|\s)@((?:~\/|\.{0,2}\/)?[\w.\/-]+)/g;

/** Where an `@path` points: relative to the file's folder, or to the home folder with ~/ (trailing punctuation off). */
function target(raw: string, dir: string, home: string): string {
  const name = raw.replace(/[.,;:]+$/, "");
  return name.startsWith("~/") ? join(home, name.slice(2)) : resolve(dir, name);
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/**
 * The files a file brings in with `@path`: at the start of a line or after a space, not inside code (``` blocks or
 * `spans`), and only when the file exists (so "@someone" stays text).
 */
function importsOf(content: string, dir: string, home: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(REFERENCE)) {
      const path = target(m[2]!, dir, home);
      if (isFile(path) && !found.includes(path)) found.push(path);
    }
  }
  return found;
}

/** The file without the `@path` tokens that were brought in. */
function stripImports(content: string, imports: string[], dir: string, home: string): string {
  if (!imports.length) return content;
  return content.replace(REFERENCE, (all, space: string, raw: string) => (imports.includes(target(raw, dir, home)) ? space : all));
}
