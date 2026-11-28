import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { diffCount, lineDiff, type DiffLine } from "./diff.ts";
import { cutMiddle, duration, Job } from "./jobs.ts";
import { foldersBelow, InstructionReader, loadInstructions, type InstructionFile } from "./instructions.ts";
import { covers, parseCommand, readsOnly, ruleFor, sameRule, writesOutside, type CommandRule } from "./shell.ts";
import type { ToolSpec } from "./providers/provider.ts";
import type { ToolCall } from "./types.ts";

/**
 * The tools the model may ask for, the same as Claude Code's: Read, Glob and Grep look around; Write and Edit change
 * files; Bash runs a command. They work in the folder where Kli runs. Reading inside it is free; writing and running
 * ask first (unless the mode or an earlier "don't ask again" says yes), and anything outside it always asks.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan";
export const MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export interface PermissionRequest {
  tool: string;
  /** "Write soma.py", "Run python3 soma.py". */
  title: string;
  /** What would change (a diff), or the command. */
  diff?: DiffLine[];
  command?: string;
  /**
   * What "don't ask again" would cover in this session: every edit, the commands that start like this one (each
   * part of a line joined by && ; |), or nothing (outside the folder, or a command that can hide another: `why`).
   */
  scope: { kind: "edits" } | { kind: "command"; rules: CommandRule[] } | { kind: "outside" } | { kind: "once"; why: string };
}
export type Answer = "yes" | "always" | "no";

export interface ToolResult {
  ok: boolean;
  /** What goes back to the model. */
  output: string;
  /** One line for people: "Read 113 lines", "Wrote 24 lines to soma.py". */
  summary: string;
  /** The person said no: the turn stops so they can say what to do instead. */
  refused?: boolean;
  /** It needed the person's permission and there was no one to ask: refused without stopping the turn. */
  denied?: boolean;
  diff?: DiffLine[];
}

/**
 * What plan mode keeps: the tools that look, Bash for the commands that only read (ls, git log…), and following or
 * stopping a command already in the background.
 */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "Bash", "BashOutput", "KillBash"]);
const MAX_LINES = 2000;
const MAX_LINE = 2000;
const MAX_OUTPUT = 30_000;

const string = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", description });
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec => ({
  name,
  description,
  parameters: { type: "object", properties, required },
});

export const TOOL_SPECS: ToolSpec[] = [
  spec(
    "Read",
    "Reads a text file and returns its lines numbered like `cat -n`. For a long file, read it in parts with offset and limit. Read a file before changing it.",
    { file_path: string("The file, absolute or relative to the working directory"), offset: integer("First line to read (1-based)"), limit: integer("How many lines (default 2000)") },
    ["file_path"],
  ),
  spec(
    "Write",
    "Writes a file (creating its folders), replacing what was there. To change part of an existing file use Edit; an existing file must be Read first.",
    { file_path: string("The file, absolute or relative to the working directory"), content: string("The whole new content") },
    ["file_path", "content"],
  ),
  spec(
    "Edit",
    "Replaces old_string with new_string in a file that was Read. old_string must match exactly, indentation included, and appear once (or set replace_all).",
    { file_path: string("The file"), old_string: string("The exact text to replace"), new_string: string("The text to put in its place"), replace_all: { type: "boolean", description: "Replace every occurrence" } },
    ["file_path", "old_string", "new_string"],
  ),
  spec(
    "Glob",
    "Finds files and folders whose path matches a pattern such as * (what is in a folder), **/*.ts or src/**/*.json, newest first; folders end with /.",
    { pattern: string("The glob pattern"), path: string("Folder to search in (default: the working directory)") },
    ["pattern"],
  ),
  spec(
    "Grep",
    "Searches the contents of files with a regular expression (ripgrep). output_mode: files_with_matches (default), content (matching lines with their numbers) or count.",
    { pattern: string("The regular expression"), path: string("File or folder (default: the working directory)"), glob: string("Only files matching this glob, e.g. *.ts"), output_mode: string("files_with_matches, content or count") },
    ["pattern"],
  ),
  spec(
    "Bash",
    "Runs a shell command in the working directory and returns its output (stdout and stderr together) and exit code. Use it to run code, tests, builds and deploys, not to read or write files (use the other tools). Commands that only read inside the folder (ls, cat, git status, git log…) run at once; the others ask the person first. It has no terminal: nothing can be typed into it, so use non-interactive flags (--yes); what needs a password or a login, ask the person to run with ! in Kli. For what keeps running (a dev server, a watcher, a long deploy) set run_in_background and follow it with BashOutput.",
    {
      command: string("The command"),
      timeout: integer("Milliseconds before it is stopped (default 120000, at most 600000); not for background commands"),
      run_in_background: { type: "boolean", description: "Start it and return at once with its id (b1); read its output with BashOutput, stop it with KillBash" },
    },
    ["command"],
  ),
  spec("BashOutput", "What a background command printed since you last read it, and whether it is still running.", { bash_id: string("The id Bash gave, such as b1") }, ["bash_id"]),
  spec("KillBash", "Stops a background command and what it started.", { bash_id: string("The id Bash gave, such as b1") }, ["bash_id"]),
];

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
const cut = (text: string, max = MAX_OUTPUT) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

/** A line with its spaces evened out: none at the ends, one between words. */
const even = (line: string) => line.trim().replace(/\s+/g, " ");

/**
 * The only place in the file where `old` is, but for its spaces (indentation, spaces between words): the whole lines
 * there, numbered from 1. Its first line may start in the middle of the file's, its last end before the file's. None
 * when there is no such place, or more than one: then the model must give the text again.
 */
export function sameButSpaces(file: string, old: string): { from: number; to: number; text: string } | undefined {
  const want = old.split("\n").map(even);
  if (!want.some(Boolean)) return undefined;
  const have = file.split("\n");
  const last = want.length - 1;
  const fits = (at: number) =>
    want.every((w, k) => {
      const line = even(have[at + k]!);
      if (want.length === 1) return line.includes(w);
      return k === 0 ? line.endsWith(w) : k === last ? line.startsWith(w) : line === w;
    });
  let found: number | undefined;
  for (let at = 0; at + want.length <= have.length; at++) {
    if (!fits(at)) continue;
    if (found !== undefined) return undefined;
    found = at;
  }
  if (found === undefined) return undefined;
  return { from: found + 1, to: found + want.length, text: have.slice(found, found + want.length).join("\n") };
}

/** The working folder and what has been allowed in it during the session. */
export class Workspace {
  mode: PermissionMode = "default";
  /** Asks the person; without it (no terminal), whatever needs permission is refused. */
  ask?: (request: PermissionRequest) => Promise<Answer>;
  /** Why no one is asked, said when something is refused for that (default: there is no terminal). */
  alone?: string;
  /** The box the commands run in (a node that writes: core/fence.ts). */
  fence?: { wrap(argv: string[]): string[] };
  private readonly read = new Set<string>();
  private edits = false;
  /** The commands allowed for the session ("don't ask again"). */
  readonly rules: CommandRule[] = [];
  private reader: InstructionReader;
  /** The AGENTS.md and CLAUDE.md files the model has, in the order it got them. */
  loaded: InstructionFile[] = [];
  /** Commands in the background, by id. */
  readonly jobs = new Map<string, Job>();
  /** Called when a background command ends. */
  onJobEnd?: (job: Job) => void;
  private nextJob = 1;
  /** The command a Bash call is waiting for, and how to let the call go on while it keeps running. */
  private foreground?: { job: Job; release: () => void };

  constructor(
    readonly root = process.cwd(),
    /** Where the person's own instructions are (~/.kli). */
    private readonly userDir?: string,
  ) {
    this.reader = new InstructionReader(root);
  }

  /** The instruction files for a new session, read again from the disk: the person's, then each folder down to here. */
  instructions(): InstructionFile[] {
    this.reader = new InstructionReader(this.root);
    this.loaded = loadInstructions(this.reader, this.userDir);
    return this.loaded;
  }

  /** The tools to offer: in plan mode, only the ones that look. */
  specs(): ToolSpec[] {
    return this.mode === "plan" ? TOOL_SPECS.filter((t) => READ_ONLY.has(t.name)) : TOOL_SPECS;
  }

  /** "file_path" as an absolute path, and whether it is inside the working folder. */
  where(path: unknown): { abs: string; shown: string; inside: boolean } {
    const raw = String(path ?? "").replace(/^~(?=\/|$)/, homedir());
    const abs = resolve(this.root, raw);
    const rel = relative(this.root, abs);
    const inside = !rel.startsWith("..") && !isAbsolute(rel);
    return { abs, shown: inside ? rel || "." : abs.replace(homedir(), "~"), inside };
  }

  /** A short form of a call, for the screen: Read(src/x.ts), Bash(npm test). */
  label(call: ToolCall): string {
    const i = call.input;
    const arg = i.file_path ?? i.pattern ?? i.command ?? i.bash_id ?? "";
    const shown = typeof i.file_path === "string" ? this.where(i.file_path).shown : String(arg);
    return `${call.name}(${shown.length > 80 ? shown.slice(0, 79) + "…" : shown})`;
  }

  private async allowed(request: PermissionRequest): Promise<ToolResult | undefined> {
    const s = request.scope;
    if (s.kind === "edits" && (this.mode === "acceptEdits" || this.edits)) return;
    if (!this.ask)
      return { ok: false, denied: true, output: `Not allowed: ${request.title} needs the person's permission, and ${this.alone ?? "there is no terminal to ask (run kli interactively, or with --permission-mode acceptEdits for file edits)"}.`, summary: "needs permission" };
    const answer = await this.ask(request);
    if (answer === "no") return { ok: false, refused: true, output: "The person refused this action. Stop and wait for their instructions.", summary: "refused" };
    if (answer === "always") {
      if (s.kind === "edits") this.edits = true;
      if (s.kind === "command") this.rules.push(...s.rules.filter((r) => !this.rules.some((had) => sameRule(had, r))));
    }
  }

  /** `onOutput` gets a command's output as it comes. */
  async run(call: ToolCall, signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<ToolResult> {
    const i = call.input;
    if ("_invalid" in i) return { ok: false, output: `The arguments were not valid JSON: ${String(i._invalid).slice(0, 200)}`, summary: "invalid arguments" };
    // a tool the mode does not offer is refused even if the model asks for it
    if (this.mode === "plan" && !READ_ONLY.has(call.name) && TOOL_SPECS.some((t) => t.name === call.name))
      return { ok: false, output: `${call.name} is not available in plan mode: only ${[...READ_ONLY].join(", ")} (Bash only for commands that read). Describe what you would do instead.`, summary: "plan mode: read only" };
    try {
      switch (call.name) {
        case "Read":
          return await this.readFile(i);
        case "Write":
          return await this.writeFile(i);
        case "Edit":
          return await this.editFile(i);
        case "Glob":
          return await this.glob(i);
        case "Grep":
          return await this.grep(i, signal);
        case "Bash":
          return await this.bash(i, signal, onOutput);
        case "BashOutput":
          return this.bashOutput(i);
        case "KillBash":
          return await this.killBash(i);
        default:
          return { ok: false, output: `There is no tool called ${call.name}. The tools are ${this.specs().map((t) => t.name).join(", ")}.`, summary: "unknown tool" };
      }
    } catch (e) {
      return { ok: false, output: `Error: ${(e as Error).message}`, summary: (e as Error).message.slice(0, 80) };
    }
  }

  private async outside(tool: string, shown: string, inside: boolean): Promise<ToolResult | undefined> {
    if (inside) return;
    return this.allowed({ tool, title: `${tool} ${shown}, outside the working folder`, scope: { kind: "outside" } });
  }

  private async readFile(i: Record<string, unknown>): Promise<ToolResult> {
    const { abs, shown, inside } = this.where(i.file_path);
    const stop = await this.outside("Read", shown, inside);
    if (stop) return stop;
    if (!existsSync(abs)) return { ok: false, output: `File not found: ${shown}`, summary: "not found" };
    if (statSync(abs).isDirectory()) return { ok: false, output: `${shown} is a folder: use Glob to list it`, summary: "is a folder" };
    const bytes = readFileSync(abs);
    if (bytes.subarray(0, 8000).includes(0)) return { ok: false, output: `${shown} is a binary file (${bytes.length} bytes)`, summary: "binary file" };
    this.read.add(abs);
    const all = bytes.toString("utf8").split("\n");
    if (all.at(-1) === "") all.pop();
    if (!all.length) return { ok: true, output: "(empty file)", summary: "empty file" };
    const offset = Math.max(1, Number(i.offset) || 1);
    const limit = Math.max(1, Math.min(MAX_LINES, Number(i.limit) || MAX_LINES));
    const part = all.slice(offset - 1, offset - 1 + limit);
    const body = part.map((l, k) => `${String(offset + k).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l}`).join("\n");
    const more = offset - 1 + part.length < all.length ? `\n… ${all.length - (offset - 1 + part.length)} more lines (read on with offset ${offset + part.length})` : "";
    // the first time the model looks inside a folder below this one, it gets that folder's instructions too
    const found = foldersBelow(this.root, abs)
      .flatMap((dir) => this.reader.folder(dir))
      .filter((f) => f.path !== abs);
    this.loaded.push(...found);
    const notes = found.map((f) => `\n\n<instructions file="${f.shown}">\nInstructions for the files in this folder; follow them.\n${f.content}\n</instructions>`).join("");
    return { ok: true, output: body + more + notes, summary: `Read ${lines(part.length)}${all.length > part.length ? ` of ${all.length}` : ""}${found.length ? ` · instructions in ${found.map((f) => f.shown).join(", ")}` : ""}` };
  }

  private async writeFile(i: Record<string, unknown>): Promise<ToolResult> {
    const { abs, shown, inside } = this.where(i.file_path);
    const content = String(i.content ?? "");
    const exists = existsSync(abs);
    if (exists && statSync(abs).isDirectory()) return { ok: false, output: `${shown} is a folder`, summary: "is a folder" };
    if (exists && !this.read.has(abs)) return { ok: false, output: `${shown} already exists and was not read in this session: Read it first, then Write or Edit it.`, summary: "read it first" };
    const before = exists ? readFileSync(abs, "utf8") : "";
    const diff = lineDiff(before, content);
    const stop = await this.allowed({ tool: "Write", title: `${exists ? "Overwrite" : "Create"} ${shown}`, diff, scope: inside ? { kind: "edits" } : { kind: "outside" } });
    if (stop) return { ...stop, diff };
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.read.add(abs);
    const n = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
    const { added, removed } = diffCount(diff);
    return { ok: true, output: `${exists ? "Updated" : "Created"} ${shown} (${lines(n)})`, summary: exists ? `Updated ${shown}: +${added} −${removed}` : `Wrote ${lines(n)} to ${shown}`, diff };
  }

  private async editFile(i: Record<string, unknown>): Promise<ToolResult> {
    const { abs, shown, inside } = this.where(i.file_path);
    if (!existsSync(abs)) return { ok: false, output: `File not found: ${shown} (use Write to create it)`, summary: "not found" };
    if (!this.read.has(abs)) return { ok: false, output: `Read ${shown} before editing it.`, summary: "read it first" };
    const before = readFileSync(abs, "utf8");
    const old = String(i.old_string ?? "");
    const next = String(i.new_string ?? "");
    if (!old) return { ok: false, output: "old_string is empty: to write a whole file use Write", summary: "empty old_string" };
    if (old === next) return { ok: false, output: "old_string and new_string are the same", summary: "nothing to change" };
    const count = before.split(old).length - 1;
    if (!count) {
      // the same text with other spaces: the lines as they are, to be copied (a model that reads "    15\t  return"
      // took the number's indentation for the code's, and asked for the same wrong text twelve times, 23/11/2026)
      const near = sameButSpaces(before, old);
      if (near)
        return {
          ok: false,
          output: `old_string was not found in ${shown}: it differs from the file only in spaces (indentation). Lines ${near.from}-${near.to} of the file are, exactly, between the lines <<< and >>>:\n<<<\n${near.text}\n>>>\nUse that text in old_string, character for character, and indent new_string the same way.`,
          summary: "text not found (spaces differ)",
        };
      return { ok: false, output: `old_string was not found in ${shown}. It must match exactly, indentation included; Read the file again.`, summary: "text not found" };
    }
    if (count > 1 && !i.replace_all) return { ok: false, output: `old_string appears ${count} times in ${shown}: give more surrounding text to make it unique, or set replace_all.`, summary: `found ${count} times` };
    const after = i.replace_all ? before.split(old).join(next) : before.replace(old, () => next);
    const diff = lineDiff(before, after);
    const stop = await this.allowed({ tool: "Edit", title: `Edit ${shown}`, diff, scope: inside ? { kind: "edits" } : { kind: "outside" } });
    if (stop) return { ...stop, diff };
    writeFileSync(abs, after);
    const { added, removed } = diffCount(diff);
    return { ok: true, output: `Edited ${shown}${count > 1 ? ` (${count} places)` : ""}`, summary: `Edited ${shown}: +${added} −${removed}`, diff };
  }

  private async glob(i: Record<string, unknown>): Promise<ToolResult> {
    const { abs, shown, inside } = this.where(i.path ?? ".");
    const stop = await this.outside("Glob", shown, inside);
    if (stop) return stop;
    // folders too (src/), so listing a folder with * shows what is in it
    const found: { path: string; mtime: number; folder: boolean }[] = [];
    for await (const path of new Bun.Glob(String(i.pattern ?? "**/*")).scan({ cwd: abs, onlyFiles: false })) {
      if (/(^|\/)(node_modules|\.git)(\/|$)/.test(path)) continue;
      let st;
      try {
        st = statSync(resolve(abs, path));
      } catch {
        continue; // a broken link
      }
      found.push({ path, mtime: st.mtimeMs, folder: st.isDirectory() });
      if (found.length >= 5000) break;
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const shownPaths = found.slice(0, 200).map((f) => this.where(resolve(abs, f.path)).shown + (f.folder ? "/" : ""));
    const more = found.length > 200 ? `\n… ${found.length - 200} more` : "";
    const folders = found.filter((f) => f.folder).length;
    const files = found.length - folders;
    const count = [`${files} file${files === 1 ? "" : "s"}`, ...(folders ? [`${folders} folder${folders === 1 ? "" : "s"}`] : [])].join(" and ");
    return { ok: true, output: shownPaths.length ? shownPaths.join("\n") + more : "Nothing found", summary: `Found ${count}` };
  }

  private async grep(i: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const { abs, shown, inside } = this.where(i.path ?? ".");
    const stop = await this.outside("Grep", shown, inside);
    if (stop) return stop;
    const mode = String(i.output_mode ?? "files_with_matches");
    const rg = Bun.which("rg");
    if (!rg) return { ok: false, output: "ripgrep (rg) is not installed: use Glob and Read, or Bash with grep", summary: "rg not installed" };
    const args = [rg, "--color=never", ...(mode === "content" ? ["-n"] : mode === "count" ? ["-c"] : ["-l"]), ...(i.glob ? ["--glob", String(i.glob)] : []), "--", String(i.pattern ?? ""), abs];
    const proc = Bun.spawn(args, { cwd: this.root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const kill = () => proc.kill();
    signal?.addEventListener("abort", kill);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    signal?.removeEventListener("abort", kill);
    if (code > 1) return { ok: false, output: `rg failed: ${(await new Response(proc.stderr).text()).trim().slice(0, 300)}`, summary: "search failed" };
    const rows = out.split("\n").filter(Boolean).map((l) => l.replace(abs + "/", "").replace(abs, shown));
    return { ok: true, output: rows.length ? cut(rows.slice(0, 500).join("\n")) + (rows.length > 500 ? `\n… ${rows.length - 500} more` : "") : "No matches", summary: `${rows.length} ${mode === "content" ? "line" : "file"}${rows.length === 1 ? "" : "s"}` };
  }

  /**
   * A command runs without asking when every part of it is covered by a rule allowed earlier in the session;
   * otherwise it asks, offering rules for the parts that were not covered (none when one of them can't have one).
   */
  private async commandAllowed(command: string): Promise<ToolResult | undefined> {
    const title = `Run ${command.length > 60 ? command.slice(0, 59) + "…" : command}`;
    const parsed = parseCommand(command);
    // plan mode runs only what reads
    if (this.mode === "plan" && ("opaque" in parsed || !parsed.parts.every((p) => readsOnly(p, this.root))))
      return { ok: false, output: "Plan mode only runs commands that read inside the folder (ls, cat, git status, git log…). Describe what you would run instead.", summary: "plan mode: read only" };
    if ("opaque" in parsed) return this.allowed({ tool: "Bash", title, command, scope: { kind: "once", why: `it has ${parsed.opaque}` } });
    const rules: CommandRule[] = [];
    let why = "";
    for (const part of parsed.parts) {
      // reading inside the folder needs no permission, by a tool or by a command
      if (readsOnly(part, this.root)) continue;
      const outside = writesOutside(part, this.root);
      if (outside.length) {
        why = `it writes ${outside[0]}, outside the folder`;
        continue;
      }
      if (this.rules.some((r) => covers(r, part))) continue;
      const rule = ruleFor(part);
      if (!rule) why ||= "a word in it comes from a variable";
      else if (!rules.some((r) => sameRule(r, rule))) rules.push(rule);
    }
    if (!why && !rules.length) return;
    return this.allowed({ tool: "Bash", title, command, scope: why ? { kind: "once", why } : { kind: "command", rules } });
  }

  private async bash(i: Record<string, unknown>, signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<ToolResult> {
    const command = String(i.command ?? "").trim();
    if (!command) return { ok: false, output: "The command is empty", summary: "empty command" };
    const stop = await this.commandAllowed(command);
    if (stop) return stop;
    const job = new Job(command, this.root, this.fence);
    if (i.run_in_background) {
      this.adopt(job);
      return { ok: true, output: `Started in the background as ${job.id}. Read its output with BashOutput (bash_id "${job.id}"); stop it with KillBash.`, summary: `running in the background as ${job.id}` };
    }
    const timeoutMs = Math.min(600_000, Math.max(1000, Number(i.timeout) || 120_000));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void job.stop();
    }, timeoutMs);
    const abort = () => void job.stop();
    signal?.addEventListener("abort", abort);
    const unlisten = onOutput && job.listen(onOutput);
    // Ctrl+B lets the call go on while the command keeps running in the background
    const released = new Promise<"released">((resolve) => (this.foreground = { job, release: () => resolve("released") }));
    const how = await Promise.race([job.done.then(() => "done" as const), released]);
    this.foreground = undefined;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    unlisten?.();
    if (how === "released") {
      job.markRead();
      const so = job.output().split("\n").slice(-20).join("\n");
      return {
        ok: true,
        output: `The person moved this command to the background as ${job.id} after ${duration(Date.now() - job.started)}; it is still running. What it printed so far (the end):\n${so || "(nothing yet)"}\nRead what comes next with BashOutput (bash_id "${job.id}").`,
        summary: `moved to the background as ${job.id}`,
      };
    }
    const text = job.output().trimEnd();
    const n = text ? text.split("\n").length : 0;
    return {
      ok: job.code === 0,
      output: `${cutMiddle(text, MAX_OUTPUT) || "(no output)"}\n[exit code ${job.code ?? "none"}${timedOut ? `, stopped after ${timeoutMs / 1000}s` : ""}]`,
      summary: `${timedOut ? "timed out" : job.code === null ? "stopped" : `exit ${job.code}`} · ${lines(n)}`,
    };
  }

  /** Gives a job its id and keeps it, to be followed with BashOutput; says when it ends. */
  private adopt(job: Job): void {
    job.id = `b${this.nextJob++}`;
    this.jobs.set(job.id, job);
    void job.done.then(() => this.onJobEnd?.(job));
  }

  /** Ctrl+B: the command the model is waiting for goes on in the background, and the model goes on too. */
  background(): Job | undefined {
    const f = this.foreground;
    if (!f) return undefined;
    this.adopt(f.job);
    f.release();
    return f.job;
  }

  /** Whether a Bash call is waiting for its command (Ctrl+B would move it). */
  get waitingForCommand(): boolean {
    return !!this.foreground;
  }

  private job(i: Record<string, unknown>): Job | ToolResult {
    const id = String(i.bash_id ?? "");
    const job = this.jobs.get(id);
    if (job) return job;
    const ids = [...this.jobs.keys()];
    return { ok: false, output: `There is no background command ${id || "with that id"}.${ids.length ? ` There are: ${ids.join(", ")}.` : " None was started."}`, summary: "no such command" };
  }

  private bashOutput(i: Record<string, unknown>): ToolResult {
    const job = this.job(i);
    if (!(job instanceof Job)) return job;
    const fresh = job.unread().trimEnd();
    if (!job.running) job.told = true;
    const n = fresh ? fresh.split("\n").length : 0;
    return { ok: true, output: `${job.id}: ${job.status()}\n${cutMiddle(fresh, MAX_OUTPUT) || "(nothing new)"}`, summary: `${job.running ? "running" : job.code === 0 ? "done" : job.code === null ? "stopped" : `exit ${job.code}`} · ${n} new line${n === 1 ? "" : "s"}` };
  }

  private async killBash(i: Record<string, unknown>): Promise<ToolResult> {
    const job = this.job(i);
    if (!(job instanceof Job)) return job;
    if (!job.running) return { ok: true, output: `${job.id} had already ended: ${job.status()}`, summary: "already ended" };
    await job.stop();
    job.told = true;
    return { ok: true, output: `Stopped ${job.id} (${job.command}): ${job.status()}`, summary: `stopped ${job.id}` };
  }

  /** Background commands that ended without the model knowing: told in the next prompt. */
  endedNotes(): string[] {
    const notes: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.running || job.told) continue;
      job.told = true;
      notes.push(`The background command ${job.id} (${job.command}) ${job.status()}. BashOutput ${job.id} shows what it printed.`);
    }
    return notes;
  }

  /** Stops every command still running (Kli is leaving). */
  async close(): Promise<void> {
    await Promise.all([...this.jobs.values(), ...(this.foreground ? [this.foreground.job] : [])].map((j) => j.stop()));
  }
}
