import { duration, envFile, heardNote, MODES, plainText, ProviderError, stackOutputs, Workspace, type Core, type DiffLine, type Exchange, type Route, type RoutedResponse, type StackConfig, type StackOptions, type StackResult, type StackRunner, type TraceEvent } from "../core/index.ts";
import type { Session } from "../core/session.ts";
import { homedir } from "node:os";
import pkg from "../../package.json" with { type: "json" };
import { collectStats } from "../core/stats.ts";
import { statsReport } from "./charts.ts";
import { Animator, type Activity } from "./animation.ts";
import { drawGolem, GOLEM_WIDTH, type Look } from "./mascot.ts";
import { takeTypedAhead, TOKENS, type Tokens } from "./theme.ts";
import { bold, changesSummary, clay, clip, dim, green, measures, red, stackMeasures, wrap, yellow } from "./output.ts";
import { markdown, type Rendered } from "./markdown.ts";
import { pickerOverlay, type Overlay } from "./overlay.ts";
import { chosen, type Picker, type PickerOption } from "./picker.ts";
import { applyStackEvent, stackRows, stackView, type StackView } from "./stack-view.ts";
import { openBrowser } from "./model-browser.ts";
import { diffRows, permissionOverlay } from "./permission.ts";
import { runYourself, shellNote } from "./shell-mode.ts";
import { openInBrowser, startBuilder, type Builder } from "./stackbuilder/server.ts";

/**
 * The session on the full terminal, like Claude Code: the conversation goes into the terminal's own scrollback, so
 * scrolling up reaches the start of the session; only the live part at the bottom (what is still changing, the golem
 * with the status, the input and the hints) is redrawn in place. A tiny renderer of our own.
 */

const SPINNER = "◐◓◑◒";
const HINTS = "Enter send · Esc/Ctrl+C stop · ! command · /model · /stack · /stats · /new · /status · /help · /exit";
/** How many of a stack's answers the model hears when it is asked again (the last ones). */
const MISSED = 5;

/** What a stack answered, as the other side of the conversation reads it: its answer, or each one side by side. */
function stackAnswer(r: StackResult): string {
  const ok = r.outputs.filter((o) => o.status === "ok" && o.text);
  if (ok.length === 1) return ok[0]!.text;
  return ok.map((o) => `[${o.node}]\n${o.text}`).join("\n\n") || "(no answer came)";
}

const SESSION_HELP = [
  "/model [name]    location → provider → model: choose one, or add, edit and delete them (/model mac/ollama/lfm3 switches)",
  "/stack [name]    a stack answers instead of the model: several models at once, joined or side by side (/stack off: the model again)",
  "/stack again     the last message the triage gave to the model alone runs on the whole stack",
  "/triage [name]   the small model that reads each message before a stack with a purpose: the stack's work, or the model alone (/triage off)",
  "/stackbuilder    a page in the browser to draw the stacks as graphs, test them with a prompt and save them",
  "/stats           outcomes, latency and tokens of this session (kli stats for all of them)",
  "/new or /clear   start a new session",
  "/status          model, fallback, instructions, user, config and session file",
  "/jobs            the commands running in the background (/jobs stop b1, /jobs stop all)",
  "!command         run a command yourself, in this terminal (a password, sudo, a login work); the model sees it with your next message",
  "/help            this help",
  "/exit or /quit   leave (also exit or quit alone, Ctrl+D, or Ctrl+C on an empty line)",
  "Esc or Ctrl+C stops the response · the terminal's scroll shows the whole session · ↑/↓ prompt history",
  "Tools: the model reads, searches, writes, edits and runs commands in this folder; writing and running ask first",
  "Ctrl+B while a command runs: it goes on in the background and the model goes on too",
  "AGENTS.md and CLAUDE.md here (and in the folders above, and in ~/.kli) are the project's instructions to the model",
  "Shift+Tab   ask before edits → accept edits → plan mode (read only)",
].join("\n");

type Entry =
  | { kind: "user" | "assistant" | "meta" | "info" | "error"; text: string }
  /** A tool the model used: ● Write(soma.py), then ⎿ what happened (the diff of an edit, the end of a command's output). */
  | { kind: "tool"; name: string; label: string; state: "running" | "ok" | "failed"; summary?: string; diff?: DiffLine[]; started: number; output?: string; agent?: boolean }
  /** A command the person ran with !: ! git push, then the end of what it printed. `echoed`: it printed on the terminal itself, only the summary is missing. */
  | { kind: "shell"; command: string; summary: string; output: string; ok: boolean; echoed?: boolean }
  /** Drawn at render time, so it follows the terminal width. */
  | { kind: "chart"; draw: (cols: number) => string[] }
  /** A stack answering: its nodes as they work, then its answers. */
  | { kind: "stack"; view: StackView };
type Status =
  | { kind: "ready" }
  | { kind: "waiting"; provider: string; since: number }
  | { kind: "streaming"; provider: string; since: number }
  /** A tool is at work: Bash(npm run build). */
  | { kind: "running"; what: string; since: number }
  /** A tool waits for the person's permission. */
  | { kind: "asking"; what: string }
  | { kind: "error"; message: string };

/** How many lines of a command's output stay on screen under it. */
const TAIL_LINES = 5;
/** How many lines of a command run with ! stay on screen. */
const SHELL_LINES = 12;
/** What is kept of a command's output for the screen (the model gets it all). */
const KEPT_OUTPUT = 20_000;

/** The permission mode under the input, as Claude Code shows it. */
const MODE_LINE: Record<string, string> = { acceptEdits: "⏵⏵ accept edits on", plan: "⏸ plan mode on" };

/** Splits raw terminal input into keys: escape sequences, control characters, pasted blocks and runs of text. */
export function* keys(data: string): Generator<string> {
  let i = 0;
  while (i < data.length) {
    if (data.startsWith("\x1b[200~", i)) {
      const end = data.indexOf("\x1b[201~", i);
      yield "paste:" + data.slice(i + 6, end < 0 ? data.length : end);
      i = end < 0 ? data.length : end + 6;
    } else if (data[i] === "\x1b") {
      const seq = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|[\x20-\x7e])?/.exec(data.slice(i))![0];
      yield seq;
      i += seq.length;
    } else if (data.charCodeAt(i) < 32 || data.charCodeAt(i) === 127) {
      yield data[i]!;
      i++;
    } else {
      let j = i;
      while (j < data.length && data.charCodeAt(j) >= 32 && data.charCodeAt(j) !== 127 && data[j] !== "\x1b") j++;
      yield "text:" + data.slice(i, j);
      i = j;
    }
  }
}

/** The input line: text as code points, a cursor, and the prompt history. */
class Editor {
  chars: string[] = [];
  cursor = 0;
  private history: string[] = [];
  private back = 0;

  get text(): string {
    return this.chars.join("");
  }

  insert(text: string): void {
    const add = Array.from(text.replace(/\r\n?/g, "\n"));
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
  }

  set(text: string): void {
    this.chars = Array.from(text);
    this.cursor = this.chars.length;
  }

  backspace(): void {
    if (this.cursor > 0) this.chars.splice(--this.cursor, 1);
  }

  del(): void {
    this.chars.splice(this.cursor, 1);
  }

  deleteWord(): void {
    let start = this.cursor;
    while (start > 0 && this.chars[start - 1] === " ") start--;
    while (start > 0 && this.chars[start - 1] !== " ") start--;
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
  }

  move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.chars.length, this.cursor + delta));
  }

  submit(): string {
    const text = this.text;
    if (text.trim()) this.history.push(text);
    this.back = 0;
    this.set("");
    return text;
  }

  recall(direction: -1 | 1): void {
    const next = this.back - direction;
    if (next < 0 || next > this.history.length) return;
    this.back = next;
    this.set(next === 0 ? "" : this.history[this.history.length - next]!);
  }
}

export async function fullscreen(core: Core, model?: string, tokens: Tokens = TOKENS.dark): Promise<number> {
  const out = process.stdout;
  const input = process.stdin;
  const editor = new Editor();
  // the folder where kli runs is where the tools work; they ask here, in the terminal
  const workspace = new Workspace(process.cwd());
  // one trace per session, whoever answers in it: the model or a stack
  let trace = core.trace("tui");
  let session: Session = core.session("tui", workspace, trace);
  if (model) session.use(model);
  // the stack chosen with /stack answers instead of the model (a model named with -m wins this time)
  let stackName = model ? undefined : core.config.stack;
  let runner: StackRunner | undefined;
  // the /stackbuilder page, up from the first /stackbuilder until the session ends
  let builder: Builder | undefined;
  let entries: Entry[] = [];
  let status: Status = { kind: "ready" };
  let last: RoutedResponse | undefined;
  let lastStack: StackResult | undefined;
  /** The last message and the answer it got, from the model or a stack: the triage reads it with the next message. */
  let lastExchange: Exchange | undefined;
  /** What a stack answered that the model's conversation has not heard yet: it hears it with its next message. */
  let missed: string[] = [];
  /** The message the triage sent to one model, until the next one: /stack again runs it on the whole stack. */
  let triaged: string | undefined;
  let totals = { prompts: 0, tokens: 0 };
  let controller: AbortController | undefined;
  // what already went to the terminal's scrollback: the entries before `committed`, and the first `partial` rows of
  // the next one (an answer still coming); `liveRow` is the row of the live part the cursor is on
  let committed = 0;
  let partial = 0;
  let liveRow = 0;
  /** The answer being written now: it settles when a tool starts or the turn ends. */
  let writing: Entry | undefined;
  /** Pickers and forms over the input line; the last one gets the keys. */
  let overlays: Overlay[] = [];
  // KLI_ANIMATION=off keeps the golem still (less motion on screen, or a slow terminal over SSH)
  const animator = new Animator(Date.now(), process.env.KLI_ANIMATION !== "off");
  let animation: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  /** The tool waiting for the person's permission (its clock starts after the answer). */
  let asked: Entry | undefined;
  /** The tool at work, if any. */
  let working: (Entry & { kind: "tool" }) | undefined;
  /** The terminal is lent to a command run with !: nothing is drawn. */
  let suspended = false;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (finish = resolve));

  const size = () => ({ rows: Math.max(out.rows || 24, 10), cols: Math.max(out.columns || 80, 40) });
  // read again each time: the editor can change the config
  const current = (): string | undefined => {
    try {
      return session.model ?? core.defaultModel();
    } catch {
      return undefined; // no model in the config yet
    }
  };
  const chain = () => (core.config.fallback ?? []).filter((f) => f !== current());
  const describe = (ref: string) => {
    try {
      const t = core.router.target(ref);
      return `${t.label} · ${t.model || "default model"}`;
    } catch {
      return ref;
    }
  };
  const stackLine = (name: string) => {
    const stack = core.config.stacks?.[name];
    if (!stack) return yellow(`stack ${name} is gone from the config · /stack`, true);
    const n = Object.keys(stack.nodes).length;
    const outs = stackOutputs(stack).length;
    return `stack ${name}` + dim(` · ${n} node${n === 1 ? "" : "s"} · ${outs > 1 ? `${outs} answers side by side` : "1 answer"}`, true);
  };
  const providerLine = () => {
    if (stackName) return stackLine(stackName);
    const now = current();
    if (!now) return yellow("no model yet · /model chooses one", true);
    const rest = chain().map(describe);
    return describe(now) + (rest.length ? dim(` · fallback ${rest.join(" → ")}`, true) : "");
  };
  const activity = (): Activity => (status.kind === "ready" || status.kind === "asking" ? "idle" : status.kind === "running" ? "waiting" : status.kind);

  function statusLine(): string {
    const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
    const spin = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length]!;
    switch (status.kind) {
      case "ready":
        return green("●", true) + " ready";
      case "waiting":
        return yellow(`${spin} waiting for ${status.provider}… ${secs(status.since)}`, true);
      case "streaming":
        return clay(`▸ ${status.provider} answering… ${secs(status.since)}`, true);
      case "running":
        return yellow(`${spin} ${status.what} · ${secs(status.since)}`, true);
      case "asking":
        return yellow(`? waiting for you: ${status.what}`, true);
      case "error":
        return red(`✕ ${status.message}`, true);
    }
  }

  /** The golem and the status beside it, at the bottom. */
  function panel(cols: number, look: Look): string[] {
    const right = [
      bold(`Kli ${pkg.version}`, true) + dim(" · ", true) + providerLine(),
      statusLine(),
      dim(lastStack ? `last ${stackMeasures(lastStack)}` : last ? `last ${measures(last)}` : "no answers yet", true),
      dim(`session ${session.id} · ${totals.prompts} prompt${totals.prompts === 1 ? "" : "s"} · ${totals.tokens} tokens`, true),
    ];
    const pad = " ".repeat(GOLEM_WIDTH + 3);
    return drawGolem(look, true).map((g, i) => clip(` ${g}${pad.slice(Bun.stringWidth(g) + 1)}${right[i] ?? ""}`, cols));
  }

  /**
   * One entry's rows; a user's prompt and a ! command get a blank row before them. `room`: the rows the screen has
   * for the live part (a running stack keeps its tree in sight within it).
   */
  function entryRows(e: Entry, i: number, cols: number, room?: number): string[] {
    const w = cols - 2;
    const lines: string[] = [];
    if (e.kind === "chart") return ["", ...e.draw(w), ""];
    if (e.kind === "stack") return stackRows(e.view, cols, Date.now(), true, room);
    if ((e.kind === "user" || e.kind === "shell") && i > 0) lines.push("");
    if (e.kind === "shell") {
      lines.push(clip(` ${yellow("!", true)} ${bold(e.command, true)}`, cols));
      for (const l of e.output.replace(/\t/g, "    ").split("\n").filter(Boolean).slice(-SHELL_LINES)) lines.push(clip(`   ${dim(`│ ${l}`, true)}`, cols));
      lines.push(clip(`   ${(e.ok ? dim : red)(`⎿ ${e.summary}`, true)}`, cols));
      return lines;
    }
    if (e.kind === "tool") {
      const dot = e.state === "running" ? yellow("●", true) : e.state === "ok" ? green("●", true) : red("●", true);
      lines.push(clip(` ${dot} ${bold(e.label, true)}`, cols));
      // a command shows the end of what it prints, while it runs and after
      // a tab would jump over what an earlier frame left on the row
      const tail = e.output ? plainText(e.output).replace(/\t/g, "    ").trimEnd().split("\n").slice(-TAIL_LINES) : [];
      for (const l of tail) lines.push(clip(`   ${dim(`│ ${l}`, true)}`, cols));
      const running =
        e.state === "running" && !e.summary && e !== asked
          ? e.agent
            ? `running ${duration(Date.now() - e.started)}`
            : e.name === "Bash"
              ? `running ${duration(Date.now() - e.started)} · ctrl+b runs it in the background`
              : undefined
          : undefined;
      const summary = e.summary ?? running;
      if (summary) lines.push(clip(`   ${dim(`⎿ ${summary}`, true)}`, cols));
      if (e.state === "ok" && e.diff?.length) lines.push(...diffRows(e.diff, cols, 12).map((l) => "  " + l));
      return lines;
    }
    if (e.kind === "assistant") return answerRows(e.text, w).rows.map((l) => " " + l);
    const wrapped = wrap(e.text, e.kind === "user" ? w - 2 : w);
    for (const [j, l] of wrapped.entries()) {
      if (e.kind === "user") lines.push(" " + clay(j === 0 ? "› " : "  ", true) + bold(l, true));
      else if (e.kind === "error") lines.push(" " + red(l, true));
      else lines.push(" " + dim(l, true));
    }
    return lines;
  }

  /** An entry that will not change again can go to the scrollback. */
  function settled(e: Entry): boolean {
    if (e.kind === "tool") return e.state !== "running";
    if (e.kind === "stack") return !!e.view.result || !!e.view.interrupted;
    if (e.kind === "assistant") return e !== writing;
    return true;
  }

  /**
   * An answer's markdown drawn for the screen. The answer still coming is drawn twice a frame (what settles, then the
   * live part), so the last drawing is kept.
   */
  let drawn: { text: string; w: number; r: Rendered } | undefined;
  function answerRows(text: string, w: number): Rendered {
    if (drawn?.text !== text || drawn.w !== w) drawn = { text, w, r: markdown(text, w, true) };
    return drawn.r;
  }

  /**
   * How many rows of an answer still coming will not change: the ones its markdown says are done (not the line being
   * written, not a table that may still grow), and never the last row with text or the blanks after it.
   */
  function stable(text: string, rows: string[], cols: number): number {
    let last = rows.length - 1;
    while (last >= 0 && !rows[last]!.trim()) last--;
    return Math.min(Math.max(0, last), answerRows(text, cols - 2).settled);
  }

  function inputLine(cols: number): { line: string; cursorCol: number } {
    const shown = editor.chars.map((c) => (c === "\n" ? "↵" : c));
    const room = cols - 4;
    let start = 0;
    while (Bun.stringWidth(shown.slice(start, editor.cursor).join("")) > room) start++;
    let end = start;
    while (end < shown.length && Bun.stringWidth(shown.slice(start, end + 1).join("")) <= room) end++;
    const before = shown.slice(start, editor.cursor).join("");
    const busy = status.kind === "waiting" || status.kind === "streaming" || status.kind === "asking" || status.kind === "running";
    const promptMark = busy ? dim("› ", true) : editor.chars[0] === "!" ? yellow("› ", true) : clay("› ", true);
    const text = shown.slice(start, end).join("");
    const placeholder = !text && !busy ? dim("ask anything · /help", true) : "";
    return { line: " " + promptMark + text + placeholder, cursorCol: 4 + Bun.stringWidth(before) };
  }

  /** What settled since the last frame: its rows go to the scrollback, once. */
  function settle(cols: number): string[] {
    const rows: string[] = [];
    while (committed < entries.length) {
      const e = entries[committed]!;
      // a ! command already printed on the terminal: only its summary is missing
      const all = e.kind === "shell" && e.echoed ? [clip(`   ${(e.ok ? dim : red)(`⎿ ${e.summary}`, true)}`, cols)] : entryRows(e, committed, cols);
      if (settled(e)) {
        rows.push(...all.slice(partial));
        if (e.kind === "shell") e.echoed = false;
        committed++;
        partial = 0;
        continue;
      }
      // an answer still coming: its lines that will not change go now, so a long one is never cut
      if (e.kind === "assistant") {
        const keep = stable(e.text, all, cols);
        if (keep > partial) rows.push(...all.slice(partial, keep));
        partial = Math.max(partial, keep);
      }
      break;
    }
    return rows;
  }

  /** The live part: what is still changing, then the golem with the status, the input and the hints (or a picker). */
  function frame(cols: number, rows: number): { rows: string[]; cursor?: [number, number]; next: number } {
    const now = Date.now();
    animator.sync(activity(), now);
    const { look, next } = animator.look(now);
    const withGolem = rows >= 20;
    const top = withGolem ? panel(cols, look) : [clip(` ${bold("Kli", true)} · ${providerLine()} · ${statusLine()}`, cols)];
    const { line, cursorCol } = inputLine(cols);
    const rule = dim("─".repeat(cols), true);
    // an open picker or form takes the place of the input line and the hints (cut from the top when too tall)
    const overlay = overlays.at(-1);
    const mode = MODE_LINE[workspace.mode];
    const behind = [...workspace.jobs.values()].filter((j) => j.running).length;
    const jobsNote = behind ? clay(`${behind} in the background`, true) + dim(" (/jobs) · ", true) : "";
    const hints = editor.chars[0] === "!" ? yellow("! runs it yourself in this terminal (passwords, sudo and logins work) · the model sees it with your next message", true) : dim(HINTS, true);
    let bottom = [line, clip(" " + (mode ? yellow(mode, true) + dim(" (shift+tab to cycle) · ", true) : "") + jobsNote + hints, cols - 1)];
    let bottomCursor: [number, number] | undefined = [0, cursorCol];
    if (overlay) {
      const room = rows - top.length - 4;
      const drawn = overlay.rows(cols, room);
      const cut = Math.max(0, drawn.rows.length - room);
      bottom = drawn.rows.slice(cut).map((r, i, all) => (i === all.length - 1 ? clip(r, cols - 1) : r));
      bottomCursor = drawn.cursor && drawn.cursor[0] >= cut ? [drawn.cursor[0] - cut, drawn.cursor[1] + 1] : undefined;
    }
    // what is still changing, under what already went to the scrollback; its top is cut if it does not fit
    const chrome = [rule, ...top, rule, ...bottom];
    const room = Math.max(0, rows - chrome.length - 1);
    const live = entries.slice(committed).flatMap((e, k) => {
      const r = entryRows(e, committed + k, cols, room);
      return k === 0 ? r.slice(partial) : r;
    });
    const shown = live.length > room ? live.slice(live.length - room) : live;
    const all = [...shown, ...chrome];
    const cursor: [number, number] | undefined = bottomCursor && [shown.length + 2 + top.length + bottomCursor[0], bottomCursor[1]];
    return { rows: all, cursor, next: withGolem ? next : Infinity };
  }

  function render(): void {
    pending = false;
    // a frame asked for just before leaving would draw over the shell and arm the golem's timer again
    if (closed || suspended) return;
    const { rows, cols } = size();
    const done = settle(cols);
    const { rows: live, cursor, next } = frame(cols, rows);
    // back to the top of the live part, clear it, add what settled to the scrollback, then the live part again
    let buf = "\x1b[?2026h\x1b[?25l\r" + (liveRow > 0 ? `\x1b[${liveRow}A` : "") + "\x1b[J";
    for (const row of done) buf += row + "\x1b[0m\r\n";
    buf += live.map((row) => row + "\x1b[0m").join("\r\n");
    const at = cursor ?? [live.length - 1, 1];
    const up = live.length - 1 - at[0];
    if (up > 0) buf += `\x1b[${up}A`;
    buf += `\x1b[${at[1]}G`;
    liveRow = at[0];
    if (cursor) buf += "\x1b[?25h";
    buf += "\x1b[?2026l";
    out.write(buf);
    // the golem's next frame
    clearTimeout(animation);
    animation = Number.isFinite(next) ? setTimeout(schedule, next) : undefined;
  }

  function schedule(): void {
    if (!pending) {
      pending = true;
      setTimeout(render, 16);
    }
  }

  /** Clears the terminal and its scrollback and prints the session again (a new width, Ctrl+L, /new). */
  function reprint(): void {
    out.write("\x1b[2J\x1b[3J\x1b[H");
    committed = 0;
    partial = 0;
    liveRow = 0;
    schedule();
  }

  /** Takes the live part off the screen (before the terminal goes to a command, or Kli leaves). */
  function eraseLive(): void {
    out.write("\r" + (liveRow > 0 ? `\x1b[${liveRow}A` : "") + "\x1b[J\x1b[?25h");
    liveRow = 0;
  }

  async function send(text: string): Promise<void> {
    if (stackName) return sendStack(stackName, text);
    return sendModel(text);
  }

  /**
   * The model answers. `triaged`: the triage of a stack sent the message here (it is on screen already), and the
   * stack's nodes hear the answer, so the conversation stays one.
   */
  async function sendModel(text: string, triagedBy?: StackRunner): Promise<void> {
    if (!triagedBy) entries.push({ kind: "user", text });
    // what the stack answered while the model was not asked
    for (const note of missed.splice(0)) session.note(note);
    // the answer is written in pieces: text, a tool, more text...; each piece of text gets its own entry
    let answer: (Entry & { kind: "assistant" }) | undefined;
    const where = () => entries.length;
    let firstText = where();
    controller = new AbortController();
    status = { kind: "waiting", provider: current() ?? "the model", since: Date.now() };
    ticker = setInterval(schedule, 100);
    const onEvent = (e: TraceEvent) => {
      if (e.type === "request") status = { kind: "waiting", provider: e.provider, since: Date.now() };
      if (e.type === "fallback") animator.fallback(Date.now());
      // before the answer, but never before what already went to the scrollback
      if (e.type === "fallback") entries.splice(Math.max(committed, answer ? entries.indexOf(answer) : firstText), 0, { kind: "info", text: `${e.from} failed (${e.reason}); asking ${e.to}` });
      schedule();
    };
    const tools = new Map<string, Entry & { kind: "tool" }>();
    try {
      const r = await session.send(text, {
        signal: controller.signal,
        onEvent,
        onDelta: (t) => {
          if (status.kind === "waiting") status = { kind: "streaming", provider: status.provider, since: status.since };
          if (!answer) {
            answer = { kind: "assistant", text: "" };
            entries.push(answer);
            writing = answer;
          }
          answer.text += t;
          schedule();
        },
        onTool: (e) => {
          if (e.phase === "start") {
            if (answer) answer.text = answer.text.trimEnd();
            answer = undefined; // what the model says after the tool goes below it
            writing = undefined;
            const entry: Entry & { kind: "tool" } = { kind: "tool", name: e.call.name, label: e.label, state: "running", started: Date.now(), ...(e.agent && { agent: true }) };
            tools.set(e.call.id, entry);
            entries.push(entry);
            firstText = where();
            working = entry;
            status = { kind: "running", what: e.label, since: Date.now() };
          } else if (e.phase === "output") {
            const entry = tools.get(e.call.id);
            if (entry) entry.output = ((entry.output ?? "") + e.output).slice(-KEPT_OUTPUT);
          } else {
            const entry = tools.get(e.call.id);
            if (entry) Object.assign(entry, { state: e.result!.ok ? "ok" : "failed", summary: e.result!.summary, diff: e.result!.diff });
            status = { kind: "waiting", provider: current() ?? "the model", since: Date.now() };
          }
          schedule();
        },
      });
      last = r;
      lastStack = undefined;
      lastExchange = { prompt: text, answer: r.text };
      triagedBy?.note(lastExchange);
      totals = { prompts: totals.prompts + 1, tokens: totals.tokens + (r.inputTokens ?? 0) + (r.outputTokens ?? 0) };
      if (r.notice) entries.push({ kind: "info", text: r.notice });
      entries.push({ kind: "meta", text: measures(r) + (r.steps > 1 ? ` · ${r.steps} steps` : "") });
      status = { kind: "ready" };
    } catch (e) {
      if (controller.signal.aborted) {
        entries.push({ kind: "info", text: "interrupted" });
        status = { kind: "ready" };
      } else if (e instanceof ProviderError) {
        entries.push({ kind: "error", text: `${e.provider}: ${e.message}` });
        status = { kind: "error", message: `${e.provider}: ${e.message}` };
      } else {
        entries.push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
        status = { kind: "error", message: "unexpected error" };
      }
    } finally {
      for (const t of tools.values()) if (t.state === "running") Object.assign(t, { state: "failed", summary: "interrupted" });
      if (answer) answer.text = answer.text.trimEnd();
      writing = undefined;
      controller = undefined;
      clearInterval(ticker);
      schedule();
    }
  }

  /** The stack answers: its tree fills in as the nodes work, and its answers come side by side when there are two. */
  async function sendStack(name: string, text: string, whole = false): Promise<void> {
    entries.push({ kind: "user", text });
    try {
      runner ??= core.stack(name, "tui", workspace.root, trace);
    } catch (e) {
      entries.push({ kind: "error", text: `${(e as Error).message} · /stack chooses another, /stack off lets the model answer` });
      return schedule();
    }
    const stackRunner = runner;
    triaged = undefined;
    if (!whole && stackRunner.triages) {
      const route = await triageFirst(stackRunner, text);
      if (!route) return;
      if (route === "one") {
        triaged = text;
        return sendModel(text, stackRunner);
      }
    }
    const r = await showStack(name, stackRunner, stackView(name, stackRunner.stack, Date.now()), (options) => stackRunner.send(text, options));
    if (!r) return;
    const answer = stackAnswer(r);
    lastExchange = { prompt: text, answer };
    missed = [...missed, heardNote({ prompt: text, answer }, `the stack ${name}`)].slice(-MISSED);
  }

  /** The triage reads the message before the stack: one model, or the stack. Undefined when the person stopped it. */
  async function triageFirst(stackRunner: StackRunner, text: string): Promise<Route | undefined> {
    controller = new AbortController();
    status = { kind: "waiting", provider: "triage", since: Date.now() };
    ticker = setInterval(schedule, 100);
    try {
      const r = (await stackRunner.triage(text, lastExchange, controller.signal))!;
      const took = `${r.model}, ${(r.ms / 1000).toFixed(1)}s`;
      entries.push({
        kind: "info",
        text: r.error
          ? `triage did not decide, so the stack runs (${took}): ${r.error}`
          : r.route === "one"
            ? `triage: the model answers alone (${took})${r.why ? ` · ${r.why}` : ""} · /stack again: the whole stack`
            : `triage: the stack's work (${took})`,
      });
      return r.route;
    } catch (e) {
      if (controller.signal.aborted) {
        entries.push({ kind: "info", text: "interrupted" });
        status = { kind: "ready" };
        return undefined;
      }
      entries.push({ kind: "info", text: `triage did not decide, so the stack runs: ${(e as Error).message}` });
      return "stack";
    } finally {
      controller = undefined;
      clearInterval(ticker);
      schedule();
    }
  }

  /**
   * A run of the stack on screen; when it ends, the changes of the nodes that write are offered, and so they are after
   * Esc: what the nodes that ended (or were stopped) changed can still be applied.
   */
  async function showStack(name: string, runner: StackRunner, view: StackView, go: (options: StackOptions) => Promise<StackResult>): Promise<StackResult | undefined> {
    entries.push({ kind: "stack", view });
    controller = new AbortController();
    status = { kind: "waiting", provider: `stack ${name}`, since: Date.now() };
    ticker = setInterval(schedule, 100);
    try {
      const r = await go({
        signal: controller.signal,
        onEvent: (e) => {
          applyStackEvent(view, e, Date.now());
          if (e.type === "delta" && status.kind === "waiting") status = { kind: "streaming", provider: status.provider, since: status.since };
          schedule();
        },
        // a node that chooses by person: the answers are on screen, side by side; the picker takes the letter
        ask: (choice) =>
          new Promise((resolve) => {
            const before = status;
            status = { kind: "asking", what: `${choice.node}: choose the answer` };
            const picker: Picker = {
              title: `Choose the answer · ${choice.node}`,
              subtitle: "it becomes the stack's answer, and the conversation goes on from it · Esc: let the next in \"by\" choose",
              options: choice.options.map((o) => ({ label: `${o.label} · ${o.node}`, value: o.label, detail: o.text.replace(/\s+/g, " ").trim().slice(0, 70) })),
              index: 0,
            };
            const overlay = pickerOverlay(picker, (result) => {
              if (result !== "choose" && result !== "cancel") return;
              overlays = overlays.filter((o) => o !== overlay);
              status = before.kind === "asking" ? { kind: "waiting", provider: `stack ${name}`, since: Date.now() } : before;
              schedule();
              resolve(result === "choose" ? chosen(picker)?.value : undefined);
            });
            overlays.push(overlay);
            schedule();
          }),
      });
      view.result = r;
      lastStack = r;
      last = undefined;
      totals = { prompts: totals.prompts + 1, tokens: totals.tokens + (r.inputTokens ?? 0) + (r.outputTokens ?? 0) };
      const ok = r.outputs.some((o) => o.status === "ok");
      // with no answer, the first reason in sight: the tree has them all, whole
      const failed = r.nodes.find((n) => n.status === "failed");
      status = ok ? { kind: "ready" } : { kind: "error", message: `stack ${name}: no answer came${failed ? ` · ${failed.node}: ${failed.error}` : ""}` };
      offerChanges(runner, r);
      return r;
    } catch (e) {
      if (controller.signal.aborted) {
        view.interrupted = true;
        entries.push({ kind: "info", text: "interrupted" });
        status = { kind: "ready" };
        const partial = (e as { result?: StackResult }).result;
        if (partial) offerChanges(runner, partial);
        else void runner.discard();
      } else {
        entries.push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
        status = { kind: "error", message: "unexpected error" };
        void runner.discard();
      }
    } finally {
      controller = undefined;
      clearInterval(ticker);
      schedule();
    }
  }

  /**
   * Nodes that changed files, each in its copy: the person chooses whose changes go to the folder, or none. Either
   * way the round ends there, and every copy goes away. The one a chooser chose comes first, then the best judged.
   */
  function offerChanges(stackRunner: StackRunner, r: StackResult): void {
    // a node that failed or was stopped keeps what it changed: offered after the others, marked as such
    // the only node that writes changed the folder itself: nothing to apply
    const changed = r.nodes.filter((n) => n.changes?.files.length && !n.changes.inFolder);
    if (!changed.length) {
      void stackRunner.discard();
      return;
    }
    const adherence: Record<string, number> = Object.fromEntries(r.nodes.flatMap((n) => n.verdict?.judged.map((j) => [j.node, j.adherence] as const) ?? []));
    const picked = r.nodes.find((n) => n.choice)?.choice?.node;
    const order = [...changed].sort((a, b) => Number(a.status !== "ok") - Number(b.status !== "ok") || Number(b.node === picked) - Number(a.node === picked) || (adherence[b.node] ?? -1) - (adherence[a.node] ?? -1));
    const picker: Picker = {
      title: "Apply which changes to your folder?",
      subtitle: "then every copy goes away, this one too · Esc: none, your folder stays as it is",
      options: [
        ...order.map((n) => ({
          label: `${n.node} · ${n.answeredBy ?? n.model}`,
          value: n.node,
          // a node that failed after changing files is judged as unfinished; one stopped by Esc is not judged
          // the adherence first: it is what compares them, and the end of a long line is what gets cut
          detail: (n.status === "ok" ? "" : `${n.status}${adherence[n.node] === undefined ? ", not judged" : ", unfinished"} · `) + (adherence[n.node] !== undefined ? `adherence ${adherence[n.node]} · ` : "") + changesSummary(n),
        })),
        { label: "none", value: "", detail: "your folder stays as it is" },
      ],
      index: 0,
    };
    const before = status;
    status = { kind: "asking", what: "apply the changes" };
    const overlay = pickerOverlay(picker, (result) => {
      if (result !== "choose" && result !== "cancel") return;
      overlays = overlays.filter((o) => o !== overlay);
      status = before;
      const value = result === "choose" ? chosen(picker)?.value : undefined;
      const node = changed.find((n) => n.node === value);
      if (!node) {
        entries.push({ kind: "info", text: "no changes applied · the copies are gone; the diffs stay next to the session" });
        void stackRunner.discard().finally(schedule);
      } else
        void stackRunner
          .apply(node)
          .then(
            () => entries.push({ kind: "info", text: `applied the changes of ${node.node} to ${workspace.root.replace(homedir(), "~")} · ${changesSummary(node)} · the copies are gone` }),
            (e: Error) => entries.push({ kind: "error", text: `${e.message} · the diff is in ${node.changes?.patchFile?.replace(homedir(), "~") ?? "its copy"}` }),
          )
          .finally(schedule);
      schedule();
    });
    overlays.push(overlay);
    schedule();
  }

  // a tool that writes or runs asks here, over the input line, and the answer goes back to the loop
  workspace.ask = (request) =>
    new Promise((resolve) => {
      const before = status;
      status = { kind: "asking", what: request.title };
      asked = working;
      const overlay = permissionOverlay(request, (answer) => {
        overlays = overlays.filter((o) => o !== overlay);
        if (asked?.kind === "tool") asked.started = Date.now();
        asked = undefined;
        status = before.kind === "asking" ? { kind: "waiting", provider: current() ?? "the model", since: Date.now() } : before.kind === "running" ? { ...before, since: Date.now() } : before;
        schedule();
        resolve(answer);
      });
      overlays.push(overlay);
      schedule();
    });

  /**
   * !command: the terminal goes to the command (keys and all) right below the conversation, then comes back; what it
   * printed stays where it is, in the scrollback, and goes to the model with the next message.
   */
  async function yourself(command: string): Promise<void> {
    render(); // what settled goes to the scrollback first
    suspended = true;
    input.off("data", onData);
    input.pause();
    if (input.isTTY) input.setRawMode(false);
    eraseLive();
    out.write("\x1b[?2004l");
    out.write(`${entries.length ? "\n" : ""} ${yellow("!", true)} ${bold(command, true)}  ${dim(`· in ${workspace.root.replace(homedir(), "~")} · Kli comes back when it ends`, true)}\n`);
    // Ctrl+C is for the command, not for Kli
    const ignore = () => {};
    process.on("SIGINT", ignore);
    let r: Awaited<ReturnType<typeof runYourself>>;
    try {
      r = await runYourself(command, workspace.root);
    } catch (e) {
      r = { code: null, ms: 0, output: `could not run it: ${(e as Error).message}` };
    } finally {
      process.off("SIGINT", ignore);
    }
    if (r.output === undefined) {
      // not recorded: the screen is the only place it is, so it stays until a key
      out.write(dim("\nnot recorded (no script command here) · Enter goes back to Kli", true));
      input.resume();
      await new Promise((resolve) => input.once("data", resolve));
    }
    out.write("\x1b[?2004h");
    if (input.isTTY) input.setRawMode(true);
    input.on("data", onData);
    input.resume();
    suspended = false;
    const lineCount = r.output ? r.output.split("\n").length : 0;
    const exit = r.code === null ? "stopped" : `exit ${r.code}`;
    entries.push({
      kind: "shell",
      command,
      ok: r.code === 0,
      output: r.output ?? "",
      summary: `${exit} · ${lineCount} line${lineCount === 1 ? "" : "s"} · ${(r.ms / 1000).toFixed(1)}s · the model sees it with your next message`,
      // recorded or not, it is on the terminal already
      echoed: true,
    });
    session.note(shellNote(command, r));
    session.trace.record({ type: "shell", command, code: r.code, ms: r.ms, content: r.output });
    schedule();
  }

  // a background command that ends says so, whatever is on screen
  workspace.onJobEnd = (job) => {
    if (closed) return;
    entries.push({ kind: "info", text: `background ${job.id} ${job.status()} · ${job.command}` });
    schedule();
  };

  /** /jobs: what runs in the background, with the end of its output; /jobs stop b1 (or all) stops it. */
  function jobs(args: string[]): void {
    const all = [...workspace.jobs.values()];
    if (args[0] === "stop") {
      const which = args[1] === "all" ? all.filter((j) => j.running) : all.filter((j) => j.id === args[1]);
      if (!which.length) {
        entries.push({ kind: "error", text: args[1] ? `no background command ${args[1]} running · /jobs lists them` : "/jobs stop b1, or /jobs stop all" });
        return;
      }
      for (const j of which) void j.stop();
      entries.push({ kind: "info", text: `stopping ${which.map((j) => j.id).join(", ")}` });
      return;
    }
    if (!all.length) {
      entries.push({ kind: "info", text: "nothing in the background · the model starts commands there (run_in_background), or Ctrl+B while one runs" });
      return;
    }
    const text = all.flatMap((j) => [
      `${j.id}  ${j.status()}  ${j.command}`,
      ...j.output().replace(/\t/g, "    ").trimEnd().split("\n").filter(Boolean).slice(-3).map((l) => `    │ ${l}`),
    ]);
    entries.push({ kind: "info", text: [...text, "/jobs stop b1 stops one · /jobs stop all"].join("\n") });
  }

  function switchTo(ref: string): void {
    try {
      const next = core.router.target(ref).ref;
      if (next === current()) {
        entries.push({ kind: "info", text: `kept ${describe(next)}` });
        return;
      }
      // the choice is the default from now on: it is in the config, so the next session (and kli "...") starts on it
      try {
        core.setDefaultModel(next);
        session.model = undefined;
        entries.push({ kind: "info", text: `now using ${describe(next)} · the default from now on` });
        if (stackName) entries.push({ kind: "info", text: `the stack ${stackName} still answers · /stack off lets the model answer` });
      } catch (e) {
        session.use(next);
        entries.push({ kind: "info", text: `now using ${describe(next)} in this session (not saved as the default: ${(e as Error).message})` });
      }
    } catch (e) {
      entries.push({ kind: "error", text: `${(e as Error).message} · /model lists what there is` });
    }
  }

  function openModels(): void {
    openBrowser({
      core,
      current,
      choose: switchTo,
      moved: (from, to) => {
        const now = session.model;
        if (!now || !(now === from || now.startsWith(`${from}/`))) return;
        session.model = undefined;
        if (to)
          try {
            session.use(to + now.slice(from.length));
          } catch {} // gone from the config: back to the config's model
      },
      push: (o) => overlays.push(o),
      pop: () => void overlays.pop(),
      close: () => void (overlays = []),
      update: schedule,
    });
  }

  /** Why a stack would not run now: a node whose model the config does not have. */
  function stackProblem(stack: StackConfig): string | undefined {
    for (const [id, node] of Object.entries(stack.nodes)) {
      // a grounding node has no model: the sources it names must be in the config
      if (node.model === undefined) {
        const missing = (node.sources ?? []).find((s) => !core.config.sources?.[s]);
        if (missing) return `${id}: "${missing}" is not one of the config's sources`;
        continue;
      }
      try {
        core.router.target(node.model);
      } catch (e) {
        return `${id}: ${(e as Error).message}`;
      }
    }
  }

  /** Makes `name` the stack that answers (none = the model), saved as the default like /model does. */
  function chooseStack(name?: string): void {
    if (name && !core.config.stacks?.[name]) {
      entries.push({ kind: "error", text: `stack "${name}" is not one of the stacks · /stack lists them` });
      return;
    }
    if (name === stackName) {
      entries.push({ kind: "info", text: name ? `kept the stack ${name}` : "the model already answers" });
      return;
    }
    void runner?.close();
    runner = undefined;
    stackName = name;
    const who = name ? `the stack ${name} answers` : `the model answers (${describe(current() ?? "none yet")})`;
    try {
      core.setStack(name);
      entries.push({ kind: "info", text: `${who} · the default from now on` });
    } catch (e) {
      entries.push({ kind: "info", text: `${who} in this session (not saved as the default: ${(e as Error).message})` });
    }
    warmTriage();
  }

  function openStacks(): void {
    const stacks = core.config.stacks ?? {};
    const names = Object.keys(stacks);
    if (!names.length) {
      entries.push({ kind: "info", text: 'no stacks yet: add them to "stacks" in the config (kli.example.json has "compara" and "revisao")' });
      return;
    }
    const options: PickerOption[] = names.map((n) => {
      const stack = stacks[n]!;
      const nodes = Object.keys(stack.nodes).length;
      const outs = stackOutputs(stack).length;
      const problem = stackProblem(stack);
      return {
        label: n,
        detail: `${nodes} node${nodes === 1 ? "" : "s"} · ${outs > 1 ? `${outs} answers` : "1 answer"}`,
        note: stack.description ?? Object.values(stack.nodes).map((x) => x.model).join(" · "),
        current: n === stackName,
        ...(problem && { problem }),
      };
    });
    options.push({ label: "none", value: "", detail: "the model answers", note: describe(current() ?? "none yet"), current: !stackName });
    const picker: Picker = { title: "Stack", subtitle: "who answers from now on: a stack, or the model (/model chooses it)", options, index: Math.max(0, options.findIndex((o) => o.current)) };
    const overlay = pickerOverlay(picker, (result) => {
      overlays = overlays.filter((o) => o !== overlay);
      if (result === "choose") chooseStack(chosen(picker)?.value || undefined);
      schedule();
    });
    overlays.push(overlay);
  }

  /** Opens the stack builder in the browser; it stays up, on this machine only, while the session is open. */
  function openBuilder(): void {
    try {
      builder ??= startBuilder(core, { root: workspace.root, onChange: builderChanged });
    } catch (e) {
      entries.push({ kind: "error", text: `the stack builder did not start: ${(e as Error).message}` });
      return;
    }
    const opened = openInBrowser(builder.url);
    entries.push({ kind: "info", text: `stack builder ${opened ? "opened in your browser" : "is up"}: ${builder.url}\nwhat you save there goes to the config, and /stack sees it · it stays up while this session is open` });
  }

  /** The page saved, renamed, deleted or chose a stack: this session follows the config, and its stack starts again. */
  function builderChanged(change: { saved?: string; previous?: string; deleted?: string; active?: string | null }): void {
    const before = stackName;
    if (change.active !== undefined) stackName = change.active ?? undefined;
    else if (change.previous && stackName === change.previous) stackName = change.saved;
    else if (change.deleted && stackName === change.deleted) stackName = undefined;
    const touched = stackName !== before || (!!stackName && (change.saved === stackName || change.previous === stackName));
    if (touched) {
      void runner?.close();
      runner = undefined;
    }
    const what = change.active !== undefined ? (change.active ? `the stack ${change.active} answers now` : "the model answers now") : change.deleted ? `deleted the stack ${change.deleted}` : `saved the stack ${change.saved}${change.previous ? ` (was ${change.previous})` : ""}`;
    entries.push({ kind: "info", text: `stack builder: ${what}${touched && stackName && change.active === undefined ? " · it answers here from the next prompt" : ""}` });
    schedule();
  }

  /** The last message the triage gave to the model alone runs on the whole stack. */
  function stackAgain(): void {
    if (!stackName) entries.push({ kind: "info", text: "no stack answers now · /stack chooses one" });
    else if (!triaged) entries.push({ kind: "info", text: "the last message already went to the stack: /stack again runs on the whole stack a message the triage gave to the model alone" });
    else void sendStack(stackName, triaged, true);
  }

  /** What the triage does now, for /status and /triage. */
  function triageLine(): string {
    const model = core.config.triage?.model;
    if (!model) return "off · the stack takes every message (/triage chooses a model)";
    const purpose = stackName ? core.config.stacks?.[stackName]?.purpose : undefined;
    return `${describe(model)} · ${!stackName ? "reads the messages when a stack with a purpose answers" : purpose ? `reads each message before ${stackName}` : `off for ${stackName}: it has no "purpose", so it takes every message`}`;
  }

  /** Makes `ref` the triage model (none = off), saved in the config like /model does. */
  function chooseTriage(ref?: string): void {
    try {
      const now = core.setTriage(ref);
      entries.push({ kind: "info", text: now ? `triage: ${describe(now)} reads each message before a stack with a purpose · saved in the config` : "triage off: the stacks take every message · saved in the config" });
      warmTriage();
    } catch (e) {
      entries.push({ kind: "error", text: `triage: ${(e as Error).message}` });
    }
  }

  /** The stack that answers gets its triage model ready in the background (a tunnel, a model to load). */
  function warmTriage(): void {
    if (!stackName) return;
    try {
      runner ??= core.stack(stackName, "tui", workspace.root, trace);
      runner.warmTriage();
    } catch {} // a stack that does not load says so on the first message
  }

  function openTriage(): void {
    openBrowser({
      core,
      current: () => core.config.triage?.model,
      choose: chooseTriage,
      moved: () => {},
      push: (o) => overlays.push(o),
      pop: () => void overlays.pop(),
      close: () => void (overlays = []),
      update: schedule,
    });
  }

  function command(line: string): void {
    const [name] = line.split(/\s+/);
    if (name === "/exit" || name === "/quit") return finish(0);
    if (name === "/stackbuilder") return openBuilder();
    if (name === "/model") {
      const wanted = line.split(/\s+/)[1];
      if (wanted) switchTo(wanted);
      else openModels();
    } else if (name === "/stack") {
      const wanted = line.split(/\s+/)[1];
      if (wanted === "again") stackAgain();
      else if (wanted === "off" || wanted === "none") chooseStack(undefined);
      else if (wanted) chooseStack(wanted);
      else openStacks();
    } else if (name === "/triage") {
      const wanted = line.split(/\s+/)[1];
      if (wanted === "off" || wanted === "none") chooseTriage(undefined);
      else if (wanted) chooseTriage(wanted);
      else openTriage();
    } else if (name === "/new" || name === "/clear") {
      const chosen = session.model;
      trace = core.trace("tui");
      session = core.session("tui", workspace, trace);
      if (chosen) session.model = chosen;
      // the stack's nodes start their conversations again too
      void runner?.close();
      runner = undefined;
      lastStack = undefined;
      lastExchange = undefined;
      missed = [];
      triaged = undefined;
      entries = [];
      last = undefined;
      totals = { prompts: 0, tokens: 0 };
      status = { kind: "ready" };
      // like /clear in Claude Code: the screen and its scrollback start again
      reprint();
    } else if (name === "/jobs") {
      jobs(line.split(/\s+/).slice(1));
    } else if (name === "/stats") {
      const id = session.id;
      entries.push({
        kind: "chart",
        draw: (cols) => statsReport(collectStats(core.sessionsDir, { sessions: [id] }), `This session · ${id}`, cols, tokens, true),
      });
    } else if (name === "/status") {
      entries.push({
        kind: "info",
        text: [
          `stack         ${stackName ? `${stackName} answers (/stack off: the model)` : "none · the model answers (/stack chooses one)"}`,
          `triage        ${triageLine()}`,
          `model         ${current() ?? "none yet"}`,
          `fallback      ${chain().join(" → ") || "none"}`,
          `folder        ${workspace.root.replace(homedir(), "~")} · tools ${workspace.mode === "plan" ? "read only (plan mode)" : workspace.mode === "acceptEdits" ? "edit without asking" : "ask before writing or running"}`,
          `instructions  ${workspace.loaded.map((f) => f.shown).join(" · ") || "none · Kli reads AGENTS.md and CLAUDE.md here, in the folders above and in ~/.kli"}`,
          `user          ${core.user}`,
          `config        ${(core.configPath ?? "").replace(homedir(), "~")}`,
          `keys          ${envFile().replace(homedir(), "~")}`,
          `session       ${session.trace.file.replace(homedir(), "~")}`,
        ].join("\n"),
      });
    } else {
      if (name !== "/help") entries.push({ kind: "error", text: `unknown command: ${name}` });
      entries.push({ kind: "info", text: SESSION_HELP });
    }
  }

  function onKey(key: string): void {
    animator.input(Date.now());
    const overlay = overlays.at(-1);
    if (overlay) {
      overlay.key(key);
      return schedule();
    }
    const busy = !!controller;
    if (key.startsWith("text:")) editor.insert(key.slice(5));
    else if (key.startsWith("paste:")) editor.insert(key.slice(6));
    else
      switch (key) {
        case "\r": {
          if (busy) {
            entries.push({ kind: "info", text: "still answering · Esc or Ctrl+C stops it" });
            break;
          }
          const text = editor.submit().trim();
          if (!text) break;
          // as in Claude Code: the word alone leaves too, without the slash (a sentence with it goes to the model)
          if (/^(exit|quit)$/i.test(text)) return finish(0);
          if (text.startsWith("!")) {
            const cmd = text.slice(1).trim();
            if (cmd) void yourself(cmd);
            else entries.push({ kind: "info", text: "!command runs it yourself, in this terminal: !git push, !sudo systemctl restart app, !gcloud auth login" });
          } else if (text.startsWith("/")) command(text);
          else void send(text);
          break;
        }
        case "\x03": // Ctrl+C
          if (busy) controller!.abort();
          else if (editor.chars.length) editor.set("");
          else finish(0);
          break;
        case "\x1b": // Esc
          if (busy) controller!.abort();
          break;
        case "\x02": {
          // Ctrl+B: the command the model waits for goes on in the background
          const job = workspace.background();
          if (job) entries.push({ kind: "info", text: `${job.id} goes on in the background · /jobs shows it` });
          break;
        }
        case "\x1b[Z": // Shift+Tab: ask before edits → accept edits → plan (read only)
          workspace.mode = MODES[(MODES.indexOf(workspace.mode) + 1) % MODES.length]!;
          break;
        case "\x04": // Ctrl+D
          if (!editor.chars.length && !busy) finish(0);
          else editor.del();
          break;
        case "\x7f":
        case "\b":
          editor.backspace();
          break;
        case "\x1b[3~":
          editor.del();
          break;
        case "\x17":
          editor.deleteWord();
          break;
        case "\x15":
          editor.set("");
          break;
        case "\x1b[D":
        case "\x1bOD":
          editor.move(-1);
          break;
        case "\x1b[C":
        case "\x1bOC":
          editor.move(1);
          break;
        case "\x01":
        case "\x1b[H":
        case "\x1bOH":
        case "\x1b[1~":
          editor.move(-Infinity);
          break;
        case "\x05":
        case "\x1b[F":
        case "\x1bOF":
        case "\x1b[4~":
          editor.move(Infinity);
          break;
        case "\x1b[A":
        case "\x1bOA":
          editor.recall(-1);
          break;
        case "\x1b[B":
        case "\x1bOB":
          editor.recall(1);
          break;
        case "\x0c": // Ctrl+L
          reprint();
          break;
      }
    schedule();
  }

  const onData = (data: string) => {
    for (const key of keys(data)) onKey(key);
  };
  // what went to the scrollback was wrapped at the old width: everything is printed again at the new one
  const onResize = () => reprint();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    // the conversation stays on the terminal; only the live part goes
    eraseLive();
    out.write("\x1b[?2004l\x1b[?25h");
    if (input.isTTY) input.setRawMode(false);
  };

  out.write("\x1b[?2004h");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.on("data", onData);
  input.resume();
  out.on("resize", onResize);
  process.once("exit", restore);
  process.once("SIGTERM", () => finish(143));
  schedule();
  warmTriage();
  // what was typed while the terminal's colors were asked
  const early = takeTypedAhead();
  if (early) onData(early);

  const code = await done;
  closed = true;
  controller?.abort();
  // what the model left running in the background stops with Kli
  await workspace.close();
  await runner?.close();
  builder?.stop();
  clearInterval(ticker);
  clearTimeout(animation);
  input.off("data", onData);
  out.off("resize", onResize);
  input.pause();
  // the last settled entries go to the scrollback, and the live part leaves
  const rest = settle(size().cols);
  eraseLive();
  out.write(rest.map((row) => row + "\x1b[0m\r\n").join(""));
  restore();
  const used = totals.prompts > 0 ? ` · session ${session.id}` : "";
  out.write(dim(`met · bye${used}`, true) + "\n");
  return code;
}
