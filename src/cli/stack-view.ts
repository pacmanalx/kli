import { duration, nodeModel, stackOrder, stackOutputs, WAITING, type NodeResult, type NodeRole, type NodeStatus, type StackConfig, type StackEvent, type StackResult, type Verdict } from "../core/index.ts";
import { bold, changesSummary, clip, dim, green, nodeLine, red, usd, wrap, yellow } from "./output.ts";
import { markdown } from "./markdown.ts";

/**
 * A stack on the full screen: the tree of its nodes, filled in as they work, then the answers on the way to the
 * stack's (an aggregator's inputs) as they come, then its answers (side by side when they fit, so two models can be
 * read together), then, once they are done, a table to compare them.
 */

const SPINNER = "◐◓◑◒";
/** Narrower than this, the answers go one under the other. */
const MIN_COLUMN = 28;
/** The fewest lines of an answer shown while the stack runs, however small the screen. */
const MIN_BODY = 3;
/** Once the stack's answer is coming, the answers on its way keep this share of the room: they were read as they came. */
const STEPS_SHARE = 1 / 3;
/** A node that answers and has gone this long with no tool and no text is said to be quiet: it may be stuck thinking. */
export const QUIET_MS = 60_000;
/** The tools that change files, in Claude Code's words (every CLI's tools are shown in them). */
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A node while its stack runs. */
export interface NodeView {
  id: string;
  role: NodeRole;
  model: string;
  from: string[];
  state: "waiting" | "running" | NodeStatus;
  started?: number;
  /** What it is doing now: a tool, the last tool it used (the model thinks after it), or answering. */
  doing?: string;
  /** The tools it asked for so far: a CLI agent's Read or Edit start and end at once, so the count shows it works. */
  tools: number;
  /**
   * What tells, while it runs, that a node may be going astray (02/11/2026: the Antigravity read docx, pptx, a main.rs
   * of 4,006 lines and a git log -p, edited only at 232 s, and then went 4.4 minutes with no tool): the lines its
   * reads brought, when its first edit ended (from its start), and its last step (a tool or text), with the tools
   * running now. It is only said to the person; nothing cuts the node off.
   */
  read: number;
  firstEdit?: number;
  lastStep?: number;
  running: number;
  /** A node that may change files: "no edit yet" means something only for it. */
  writes: boolean;
  /** Kli is doing something around the model (making its copy, the check): the node is not quiet then. */
  around?: boolean;
  /** Its answer so far. */
  text: string;
  result?: NodeResult;
  /** A node waiting for the person to choose: the answers, by letter. */
  asking?: { label: string; node: string }[];
}

export interface StackView {
  name: string;
  started: number;
  nodes: NodeView[];
  /** The nodes whose answers the stack gives. */
  outputs: string[];
  result?: StackResult;
  interrupted?: boolean;
}

export function stackView(name: string, stack: StackConfig, now: number): StackView {
  return {
    name,
    started: now,
    nodes: stackOrder(stack).map((id) => ({
      id,
      role: stack.nodes[id]!.role ?? "answer",
      model: nodeModel(stack.nodes[id]!),
      from: stack.nodes[id]!.from ?? [],
      state: "waiting",
      text: "",
      tools: 0,
      read: 0,
      running: 0,
      writes: stack.nodes[id]!.tools === "write",
    })),
    outputs: stackOutputs(stack),
  };
}

/** One event of the run, on the view. */
export function applyStackEvent(view: StackView, e: StackEvent, now: number): void {
  const node = view.nodes.find((n) => n.id === e.node);
  if (!node) return;
  if (e.type === "start") Object.assign(node, { state: "running", started: now, lastStep: now, doing: node.role === "verify" ? "judging" : WAITING });
  else if (e.type === "delta") {
    node.text += e.text;
    node.doing = "answering";
    Object.assign(node, { lastStep: now, around: false });
  } else if (e.type === "tool") {
    Object.assign(node, { lastStep: now, around: false });
    if (e.event.phase === "start") {
      node.tools++;
      node.running++;
    }
    if (e.event.phase === "end") {
      node.running = Math.max(0, node.running - 1);
      const r = e.event.result;
      if (r?.ok && e.event.call.name === "Read") node.read += linesRead(r.summary, r.output);
      if (r?.ok && EDITS.has(e.event.call.name)) node.firstEdit ??= now - (node.started ?? now);
    }
    // the model thinks after a tool: the last one stays in sight, so a node between steps does not look stopped
    if (e.event.phase !== "output") node.doing = e.event.phase === "end" ? `last ${e.event.label}` : e.event.label;
  }
  else if (e.type === "asking") Object.assign(node, { asking: e.options, doing: "waiting for you to choose" });
  // Kli's own work around the model (its copy, the check) is not the node being quiet; back to the model, it counts again
  else if (e.type === "doing") Object.assign(node, { doing: e.what, around: e.what !== WAITING, ...(e.what === WAITING && { lastStep: now }) });
  // an answer cut short keeps what had come
  else Object.assign(node, { state: e.result.status, result: e.result, text: e.result.text || node.text, doing: undefined, model: e.result.model, asking: undefined });
}

/** The lines a Read brought: as its summary says ("Read 50 lines of 4006", a CLI's "17 lines"), else its output's. */
function linesRead(summary: string, output: string): number {
  const said = /(\d+) lines?\b/.exec(summary);
  if (said) return Number(said[1]);
  return output.trimEnd() ? output.trimEnd().split("\n").length : 0;
}

/** 950, 9.4k, 120k. */
const count = (n: number) => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`);

/**
 * What the node's line says, while it runs, of how it goes: how much it read, its first edit (or none yet, when it
 * may change files), and how long it has been quiet (no tool running, no tool and no text for `QUIET_MS`).
 */
export function signals(n: NodeView, now: number): { said: string[]; quiet?: string } {
  const said: string[] = [];
  if (n.read) said.push(`read ${count(n.read)} line${n.read === 1 ? "" : "s"}`);
  if (n.writes && n.role === "answer" && n.tools) said.push(n.firstEdit === undefined ? "no edit yet" : `first edit at ${duration(n.firstEdit)}`);
  const still = now - (n.lastStep ?? now);
  const quiet = n.role === "answer" && !n.running && !n.around && still >= QUIET_MS ? `quiet for ${duration(still)}` : undefined;
  return { said, ...(quiet && { quiet }) };
}

const width = (s: string) => Bun.stringWidth(s);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

function nodeRow(n: NodeView, now: number, color: boolean): string {
  // why it failed or was skipped goes on lines of its own, under it (`reasonRows`)
  if (n.result) return nodeLine(n.result, color, false);
  if (n.state === "running") {
    const spin = SPINNER[Math.floor(now / 120) % SPINNER.length]!;
    const tools = n.tools ? ` · ${n.tools} tool${n.tools === 1 ? "" : "s"}` : "";
    // how it goes before what it does now: on a narrow screen, the end of the line is what gets cut
    const { said, quiet } = signals(n, now);
    const head = dim(`${duration(now - (n.started ?? now))}${tools}${said.map((s) => ` · ${s}`).join("")}`, color);
    return `${yellow(spin, color)} ${bold(n.id, color)}  ${dim(n.model, color)} · ${head}${quiet ? ` · ${yellow(quiet, color)}` : ""} · ${dim(n.doing ?? "", color)}`;
  }
  const waits = n.from.length ? ` · waits for ${n.from.join(", ")}` : "";
  return `${dim("·", color)} ${bold(n.id, color)}  ${dim(n.model + waits, color)}`;
}

/**
 * Why a node failed or was skipped, whole, under its line in the tree. At the end of the line the screen cut it off,
 * and the stack seemed to die in silence (12/11/2026: "agy ends the run th…").
 */
export function reasonRows(n: NodeView, last: boolean, cols: number, color: boolean): string[] {
  const r = n.result;
  if (!r?.error || (r.status !== "failed" && r.status !== "skipped")) return [];
  const text = r.status === "failed" ? r.error : `skipped: ${r.error}`;
  return wrap(text, Math.max(20, cols - 6)).map((l) => ` ${dim(last ? " " : "│", color)}   ${r.status === "failed" ? red(l, color) : dim(l, color)}`);
}

/** An answer's place: its text, and how it ended when it did not end well (waiting, failed, skipped, cut short). */
function placeholder(n: NodeView): string {
  const end =
    n.state === "failed" ? `✕ ${n.result?.error ?? "failed"}` : n.state === "skipped" ? `– skipped: ${n.result?.error ?? ""}` : n.state === "interrupted" ? "■ interrupted" : "";
  if (n.text) return end ? `${n.text.trimEnd()}\n${end}` : n.text;
  return end || (n.state === "ok" ? "(it answered with no text)" : "…");
}

/** How many tools of each kind a node used: Glob, Bash ×2 (1 failed). */
function toolsCell(r: NodeResult): string {
  if (!r.tools.length) return "none";
  const counts = new Map<string, number>();
  for (const t of r.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const failed = r.tools.filter((t) => !t.ok).length;
  const refused = r.tools.filter((t) => t.refused).length;
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ") + (failed ? ` (${failed} failed${refused ? `, ${refused} refused` : ""})` : "");
}

/** The comparison of the answers, one column each; with a verdict, how much each adheres to the request too. */
export function comparisonRows(outputs: NodeResult[], cols: number, color = true, adherence: Record<string, number> = {}): string[] {
  const secs = (ms?: number) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)}s`);
  const rows: [string, (r: NodeResult) => string][] = [
    ["", (r) => r.node],
    ["status", (r) => ({ ok: "✓ answered", failed: "✕ failed", skipped: "– skipped", interrupted: "■ interrupted" })[r.status]],
    ["time", (r) => secs(r.ms)],
    ["first text", (r) => secs(r.firstTokenMs)],
    ["tokens", (r) => (r.inputTokens === undefined ? "–" : `${r.inputTokens}→${r.outputTokens ?? "?"}`)],
    ...(outputs.some((o) => o.thinkingTokens) ? [["thinking", (r: NodeResult) => String(r.thinkingTokens ?? 0)] as [string, (r: NodeResult) => string]] : []),
    ["tok/s", (r) => (r.tokensPerSecond === undefined ? "–" : String(r.tokensPerSecond))],
    ["tools", toolsCell],
    ["steps", (r) => String(r.steps)],
  ];
  if (outputs.some((o) => adherence[o.node] !== undefined)) rows.splice(2, 0, ["adherence", (r) => (adherence[r.node] === undefined ? "–" : `${adherence[r.node]}/100`)]);
  if (outputs.some((o) => o.costUsd !== undefined)) rows.splice(6, 0, ["cost", (r) => (r.costUsd === undefined ? "–" : usd(r.costUsd))]);
  if (outputs.some((o) => o.changes)) rows.push(["changes", (r) => (r.changes ? (r.changes.files.length ? `${r.changes.files.length} file${r.changes.files.length === 1 ? "" : "s"} +${r.changes.added} −${r.changes.removed}` : "none") : "–")]);
  if (outputs.some((o) => o.check)) rows.push(["check", (r) => (r.check ? (r.check.ok ? "✓ passed" : "✕ failed") : "–")]);
  const labelW = Math.max(...rows.map(([l]) => width(l)));
  const cells = rows.map(([l, f]) => [l, ...outputs.map(f)]);
  const room = Math.max(8, Math.floor((cols - 1 - labelW - 3 * outputs.length) / outputs.length));
  const colW = outputs.map((_, i) => Math.min(room, Math.max(...cells.map((c) => width(c[i + 1]!)))));
  return cells.map((c, j) => {
    const line = [pad(c[0]!, labelW), ...c.slice(1).map((v, i) => pad(width(v) > colW[i]! ? v.slice(0, colW[i]! - 1) + "…" : v, colW[i]!))].join("   ").trimEnd();
    return clip(" " + (j === 0 ? bold(line, color) : c[0] === "status" ? line.replace(/✕ failed/g, red("✕ failed", color)) : dim(line, color)), cols);
  });
}

/** The stack on screen: its tree, its answers, and the comparison when it is done and has more than one answer. */
/**
 * The stack's rows. `room`, while it runs: the rows the screen has for it. The tree stays in sight and the answers
 * show their last lines (the screen cuts what does not fit from the top, and the tree is the top); when it ends, the
 * whole answers go to the scrollback.
 */
export function stackRows(view: StackView, cols: number, now: number, color = true, room?: number): string[] {
  const w = cols - 2;
  const r = view.result;
  const answered = view.nodes.filter((n) => n.state === "ok").length;
  const head = r
    ? [
        `${(r.ms / 1000).toFixed(1)}s`,
        `${answered} of ${view.nodes.length} nodes answered`,
        ...(r.inputTokens !== undefined ? [`${r.inputTokens}→${r.outputTokens ?? "?"} tokens`] : []),
        ...(r.costUsd !== undefined ? [usd(r.costUsd)] : []),
        ...(r.nodeMs - r.ms >= 1000 ? [`side by side saved ${((r.nodeMs - r.ms) / 1000).toFixed(1)}s`] : []),
      ].join(" · ")
    : view.interrupted
      ? "interrupted"
      : [duration(now - view.started), `${answered} of ${view.nodes.length} done`].join(" · ");
  const rows = [clip(` ${yellow("◆", color)} ${bold(`stack ${view.name}`, color)} ${dim(`· ${head}`, color)}`, cols)];
  view.nodes.forEach((n, i) => {
    const last = i === view.nodes.length - 1;
    rows.push(clip(` ${dim(last ? "└" : "├", color)} ${nodeRow(n, now, color)}`, cols));
    rows.push(...reasonRows(n, last, cols, color));
  });

  const outputs = view.outputs.map((id) => view.nodes.find((n) => n.id === id)!);
  const asking = view.nodes.some((n) => n.asking);
  rows.push("");
  // while it runs, the answers get what is left under the tree (a node that asks the person shows them whole)
  const body = room !== undefined && !r && !asking ? Math.max(MIN_BODY, room - rows.length - 1) : undefined;
  // the answers on the way to the stack's (07/11/2026: with three that answer and an aggregator, only the aggregator's
  // text was in sight): each one as it comes, above the stack's; a node that asks the person shows them already
  const steps = asking ? [] : view.nodes.filter((n) => !view.outputs.includes(n.id) && (n.role === "answer" || n.role === "aggregate") && n.state !== "waiting" && n.state !== "skipped");
  const single = outputs.length === 1 ? outputs[0]! : undefined;
  // one answer of the stack takes no room until it has something to show
  const outputShown = !single || !!single.text || (single.state !== "waiting" && single.state !== "running");
  // with both in sight, a third for the answers on the way and the rest for the stack's, each at least its fewest rows
  let stepsRoom = body;
  let outputRoom = body;
  if (body !== undefined && steps.length && outputShown) {
    const most = body - fewestRows(outputs.length, cols) - 1;
    stepsRoom = Math.max(fewestRows(steps.length, cols), Math.min(Math.floor(body * STEPS_SHARE), most));
    outputRoom = Math.max(MIN_BODY, body - stepsRoom - 1);
  }
  if (steps.length) rows.push(...answerColumns(steps.map((s) => ({ title: s.id, model: s.model, text: placeholder(s) })), cols, color, stepsRoom));
  if (single && steps.length) {
    // under the others, the stack's answer says whose it is
    if (outputShown) rows.push("", ...answerColumns([{ title: single.id, model: single.model, text: placeholder(single) }], cols, color, outputRoom));
  } else if (single) {
    const text = single.text || (single.state === "waiting" || single.state === "running" ? "" : placeholder(single));
    const lines = text ? markdown(text.trim(), w, color).rows : [];
    for (const l of tail(lines, body, color)) rows.push(" " + (single.text ? l : red(l, color)));
  } else {
    if (steps.length) rows.push("");
    rows.push(...answerColumns(outputs.map((o) => ({ title: o.id, model: o.model, text: placeholder(o) })), cols, color, outputRoom));
    if (r) rows.push("", ...comparisonRows(r.outputs, cols, color, adherenceOf(view)));
  }
  // a node waiting for the person: the answers to choose from, by letter, side by side
  for (const n of view.nodes.filter((n) => n.asking)) {
    const options = n.asking!.map((o) => ({ title: `${o.label} · ${o.node}`, model: view.nodes.find((x) => x.id === o.node)?.model ?? "", text: view.nodes.find((x) => x.id === o.node)?.text ?? "" }));
    rows.push("", clip(` ${yellow("?", color)} ${bold(`${n.id}: choose the answer`, color)} ${dim("· the number below picks it", color)}`, cols), ...answerColumns(options, cols, color));
  }
  // a chooser that chose: who, why, and why the ones before it did not
  for (const n of view.nodes) {
    const c = n.result?.choice;
    if (!c) continue;
    const why = c.why ? `: ${c.why}` : "";
    rows.push(...wrap(`${n.id} chose ${c.node} (${c.label}), by ${c.by}${why}`, w).map((l) => " " + dim(l, color)));
    for (const p of c.passed ?? []) rows.push(...wrap(`passed over ${p}`, w).map((l) => " " + dim(l, color)));
  }
  for (const n of view.nodes) if (n.result?.verdict) rows.push("", ...verdictRows(n.result.verdict, `${n.id} · ${n.result.answeredBy ?? n.model}`, view.outputs, cols, color));
  if (r) rows.push(...groundRows(r.nodes, cols, color));
  if (r) rows.push(...changesRows(r.nodes, cols, color));
  return rows;
}

/** What each grounding node handed on: its excerpts, numbered as the next step read them, and each source's say. */
export function groundRows(nodes: NodeResult[], cols: number, color = true): string[] {
  const rows: string[] = [];
  let n = 0;
  for (const r of nodes.filter((x) => x.grounding)) {
    const g = r.grounding!;
    const head = [`${g.mode}`, `${g.items.length} excerpt${g.items.length === 1 ? "" : "s"}`, `${g.tokens} tokens`, ...(g.cut ? [`${g.cut} left out by the budget`] : [])].join(" · ");
    rows.push("", clip(` ${yellow("◈", color)} ${bold(r.node, color)} ${dim(`· grounding · ${head}`, color)}`, cols));
    for (const it of g.items) rows.push(clip(`   ${dim(`[${++n}]`, color)} ${it.source} · ${it.ref}${it.relevance !== undefined ? dim(` · ${it.relevance.toFixed(2)}`, color) : ""}`, cols));
    for (const s of g.sources) if (s.error || !s.found) rows.push(clip(`   ${dim(`${s.name}: ${s.error ?? "nothing found"}`, color)}`, cols));
  }
  return rows;
}

/** Most files listed for one node; the rest are counted. */
const MAX_FILES = 12;

/** What the nodes that write changed, in their copies or in the folder: the files, the check, and where the whole diff is. */
export function changesRows(nodes: NodeResult[], cols: number, color = true): string[] {
  const rows: string[] = [];
  for (const n of nodes.filter((n) => n.changes)) {
    const c = n.changes!;
    // a node that did not finish still changed these: said, and whether a judge judged them as unfinished work
    const judged = nodes.some((x) => x.verdict?.judged.some((j) => j.node === n.node));
    const ended = n.status === "ok" ? "" : `${n.status}, ${judged ? "unfinished" : "not judged"} · `;
    rows.push("", clip(` ${yellow("✎", color)} ${bold(n.node, color)} ${dim(`· ${n.answeredBy ?? n.model} · ${ended}${changesSummary(n)}`, color)}`, cols));
    for (const f of c.files.slice(0, MAX_FILES)) rows.push(clip(`   ${f.path} ${f.binary ? dim("binary", color) : `${green(`+${f.added}`, color)} ${red(`−${f.removed}`, color)}`}`, cols));
    if (c.files.length > MAX_FILES) rows.push(dim(`   … ${c.files.length - MAX_FILES} more`, color));
    // where the check came from: the person never told Kli, so it says what it used
    const p = n.project;
    const how = p?.source
      ? [n.check ? `checked with ${n.check.command}` : c.files.length ? "no check" : "not checked: it changed no file", `from ${p.source}`].join(" · ")
      : "no check: the project declares none (.kli/write.json) and its files show none";
    for (const l of wrap(how, cols - 4)) rows.push(`   ${dim(l, color)}`);
    // what its commands could touch: the fence, or why they ran without one
    if (p?.fence || p?.unfenced) rows.push(clip(`   ${dim(p.fence ? `fenced by ${p.fence}` : `not fenced: ${p.unfenced}`, color)}`, cols));
    if (n.check && !n.check.ok) for (const l of n.check.output.split("\n").slice(-4)) rows.push(clip(`   ${dim(l, color)}`, cols));
    // the path is what one copies to apply it: wrapped, never cut
    if (c.patchFile) for (const l of wrap(`diff: ${c.patchFile.replace(process.env.HOME ?? "~", "~")}`, cols - 4)) rows.push(`   ${dim(l, color)}`);
  }
  return rows;
}

/** Answers side by side, each under its title and model (one under the other when the screen is too narrow). */
/** The last `room` lines, the first of them saying how many came before; all of them without a room. */
function tail(lines: string[], room: number | undefined, color: boolean): string[] {
  if (room === undefined || lines.length <= room) return lines;
  const kept = lines.slice(lines.length - (room - 1));
  return [dim(`↑ ${lines.length - kept.length} lines above`, color), ...kept];
}

/** Whether n answers go side by side: two or more, each column at least `MIN_COLUMN` wide. */
const sideBySide = (n: number, cols: number) => n > 1 && Math.floor((cols - 2 - 3 * (n - 1)) / n) >= MIN_COLUMN;

/**
 * The fewest rows `answerColumns` takes for n answers in a room: side by side, the titles and `MIN_BODY` lines; one
 * under the other, each its heading and `MIN_BODY` lines, with a blank row between them.
 */
const fewestRows = (n: number, cols: number) => (sideBySide(n, cols) ? 1 + MIN_BODY : n * (1 + MIN_BODY) + n - 1);

/**
 * Answers side by side (one under the other when the screen is narrow, and one alone under its own heading);
 * `room`: the most rows they may take.
 */
function answerColumns(items: { title: string; model: string; text: string }[], cols: number, color: boolean, room?: number): string[] {
  const w = cols - 2;
  const rows: string[] = [];
  const colW = Math.floor((w - 3 * (items.length - 1)) / items.length);
  if (sideBySide(items.length, cols)) {
    const titles = items.map((o) => clip(bold(o.title, color) + dim(` · ${o.model}`, color), colW));
    // each column keeps its own last lines: a short answer next to a long one does not fall out of sight
    const bodies = items.map((o) => tail(markdown((o.text || "…").trim(), colW, color).rows, room === undefined ? undefined : room - 1, color));
    const height = Math.max(...bodies.map((b) => b.length));
    const sep = dim(" │ ", color);
    rows.push(" " + titles.map((t, i) => (i < titles.length - 1 ? t + " ".repeat(Math.max(0, colW - visible(t))) : t)).join(sep));
    for (let k = 0; k < height; k++) rows.push((" " + bodies.map((b, i) => (i < bodies.length - 1 ? pad(b[k] ?? "", colW) : (b[k] ?? ""))).join(sep)).trimEnd());
    return rows;
  }
  items.forEach((o, i) => {
    if (i) rows.push("");
    rows.push(clip(" " + dim("── ", color) + bold(o.title, color) + dim(` · ${o.model} ──`, color), cols));
    const share = room === undefined ? undefined : Math.max(MIN_BODY, Math.floor(room / items.length) - 2);
    for (const l of tail(markdown((o.text || "…").trim(), w, color).rows, share, color)) rows.push(" " + l);
  });
  return rows;
}

/** Each judged node's adherence, from the verifiers that are done (the last one wins). */
function adherenceOf(view: StackView): Record<string, number> {
  return Object.fromEntries(view.nodes.flatMap((n) => n.result?.verdict?.judged.map((j) => [j.node, j.adherence] as const) ?? []));
}

const MARKS = { met: ["✓", green], partial: ["~", yellow], missing: ["✕", red] } as const;

/**
 * A verifier's verdict: the request's requirements down the side, the answers it judged across, a mark in each
 * cell, then each one's adherence, how much the answer of the stack beat the best of the others, and the notes.
 */
export function verdictRows(verdict: Verdict, by: string, outputs: string[], cols: number, color = true): string[] {
  const names = verdict.judged.map((j) => j.node);
  const colW = names.map((n) => Math.max(width(n), 9) + 2);
  const labelW = Math.max(16, cols - 3 - colW.reduce((t, w) => t + w, 0));
  const cell = (text: string, w: number) => pad(text, w);
  const rows = [clip(` ${yellow("◇", color)} ${bold("adherence to the request", color)} ${dim(`· judged by ${by}`, color)}`, cols)];
  rows.push(" " + " ".repeat(labelW) + names.map((n, i) => bold(cell(n, colW[i]!), color)).join("").trimEnd());
  verdict.requirements.forEach((req, k) => {
    const lines = wrap(`${k + 1}. ${req}`, labelW - 1);
    lines.forEach((l, li) => {
      const marks = li === 0 ? verdict.judged.map((j, i) => {
        const [glyph, paint] = MARKS[j.items[k]!];
        return paint(glyph, color) + " ".repeat(colW[i]! - 1);
      }).join("") : "";
      rows.push((" " + pad(l, labelW) + marks).trimEnd());
    });
  });
  rows.push((" " + bold(pad("adherence", labelW), color) + verdict.judged.map((j, i) => bold(cell(`${j.adherence}/100`, colW[i]!), color)).join("")).trimEnd());
  // the stack's answer against the answers it was made from
  for (const out of verdict.judged.filter((j) => outputs.includes(j.node))) {
    const others = verdict.judged.filter((j) => !outputs.includes(j.node));
    if (!others.length) continue;
    const best = others.reduce((a, b) => (b.adherence > a.adherence ? b : a));
    const diff = out.adherence - best.adherence;
    const how = diff > 0 ? `+${diff} over` : diff < 0 ? `${diff} under` : "the same as";
    rows.push(" " + (diff > 0 ? green : diff < 0 ? red : dim)(`${out.node}: ${how} the best of the others (${best.node} ${best.adherence})`, color));
  }
  for (const j of verdict.judged.filter((j) => j.note)) for (const l of wrap(`${j.node}: ${j.note}`, cols - 3)) rows.push(" " + dim(l, color));
  return rows;
}

/** Width on screen of a row that may carry colors. */
const visible = (s: string) => width(s.replace(/\x1b\[[0-9;]*m/g, ""));
