import { dirname, join } from "node:path";
import { claimCopies, Copy, Here, removeLeftovers, repoOf, runIn, Snapshots, type Changes, type CommandResult, type Repo } from "./copies.ts";
import { Fence } from "./fence.ts";
import { ground, Sources, type GroundResult } from "./ground.ts";
import { projectCommands, projectFolders, type ProjectCommands } from "./project.ts";
import type { Router } from "./router.ts";
import { Session, type ToolEvent } from "./session.ts";
import { parseCommand } from "./shell.ts";
import { heardNote, triage, type Exchange, type TriageResult } from "./triage.ts";
import { aggregatePrompt, choosePrompt, contributionsCut, joinPrompt, LETTERS, nodeModel, readChoice, readContributions, readVerdict, stackOrder, stackOutputs, verifyPrompt, withChanges, withCheck, writesInFolder, type Answer, type Grounding, type Verdict } from "./stack.ts";
import { Workspace } from "./tools.ts";
import type { NodeStatus, Trace } from "./trace.ts";
import { ProviderError, type Chooser, type NodeRole, type SourceConfig, type StackConfig, type StackNode } from "./types.ts";

/** A text written in less time than this gives no speed worth showing. */
const MIN_SPEED_MS = 300;

/**
 * How a node that writes is asked to work, the same for every one of them. No clock cuts a node off (it ends when its
 * model does, or when the person stops it), but the person waits for it: a CLI that read whole files again and again
 * and thought for minutes between steps took four times as long as another for the same request.
 */
export function pace(): string {
  return [
    "Work to the request, at a steady pace: nothing cuts this step off, but the person is waiting for it.",
    "- Search before you read (grep for the names you need); in a long file, read only the part you need; do not read again a file you have read.",
    "- When reads or edits do not depend on each other, ask for them together, in one step.",
    "- Edit as soon as you know what to change, one part at a time; change only what the request asks for, and leave decisions it does not ask for to the person.",
    "- Check once, at the end (the project's tests), then say which files you changed and why.",
  ].join("\n");
}

/** What a node does while its model has not said anything yet. */
export const WAITING = "waiting for the model";

/** What each node that writes hears when a round ended with none of the changes applied. */
export const NOTHING_APPLIED = "None of the changes from the last request were applied: the person's folder stays as it was, and your copy of it is gone. This request starts from a new copy of the folder as it is now.";

/** What a node hands on to the next ones: its answer, without a CLI's narration. */
const handed = (r: NodeResult) => r.answer ?? r.text;

/** How much a node that writes changed, for the ones that judge or choose: every answer's side by side. */
const sizeOf = (r: NodeResult) => r.changes && { files: r.changes.files.length, added: r.changes.added, removed: r.changes.removed };

/**
 * What a judge judges: an answer, or the work a node left when it failed after changing files (a CLI that fell, a
 * connection that dropped), said to be unfinished. A node stopped by Esc is not judged: the judge stops with it.
 */
const judgeable = (r?: NodeResult): r is NodeResult => r?.status === "ok" || (r?.status === "failed" && !!r.changes?.files.length);

/** The tools a node used, for the ones that judge or choose: Bash(npm test) (failed). */
const toolLabels = (r: NodeResult) => r.tools.map((t) => t.label + (t.refused ? " (refused)" : t.ok ? "" : " (failed)"));

/** A node's tools: what it says, or else read to answer and none to aggregate, verify or choose. */
const toolsOf = (node: StackNode) => node.tools ?? ((node.role ?? "answer") === "answer" ? "read" : "none");

/** The commands the stack lets the nodes that write run: each one allows the commands that start with it. */
const allowedRules = (run: string[] = []) =>
  run.flatMap((command) => {
    const parsed = parseCommand(command);
    return "opaque" in parsed || parsed.parts.length !== 1 ? [] : [{ words: parsed.parts[0]!.words, exact: false }];
  });

/** What one node did, measured. */
export interface NodeResult {
  node: string;
  role: NodeRole;
  /** The model it was set to, in full. */
  model: string;
  /** The model that answered (another one when its fallback did). */
  answeredBy?: string;
  status: NodeStatus;
  /** All it said, as the screen showed it: a CLI agent's narration of each step too. */
  text: string;
  /**
   * What the next nodes get, when it is not the whole text: a CLI agent's last message, without the narration of its
   * steps ("I will read…", "Let me test…"). The Antigravity's answer to a review went to the judge with 104 thousand
   * characters of it (02/11/2026).
   */
  answer?: string;
  ms: number;
  /** From the start of the node to its first piece of text. */
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Text tokens (the output without the thinking) over the time after the first one. */
  tokensPerSecond?: number;
  /** How many of the output tokens were thinking. */
  thinkingTokens?: number;
  costUsd?: number;
  /** Model turns, counting the ones that asked for tools. */
  steps: number;
  /** `refused`: it needed a permission no one in a stack gives (a command the node may not run, a file outside). */
  tools: { name: string; label: string; ok: boolean; refused?: boolean }[];
  error?: string;
  /** An aggregator's: how much of its answer came from each node it got (shares adding up to 100). */
  contributions?: Record<string, number>;
  /** A verifier's: the request's requirements and how each node it judged meets them. */
  verdict?: Verdict;
  /** A verifier's: how many rounds it judged in, when more than one (it judges the answers as they come). */
  rounds?: number;
  /** A chooser's: the answer it chose, who chose it and why, and why the ones before in `by` did not. */
  choice?: { node: string; label: string; by: Chooser; why?: string; passed?: string[] };
  /** A node that writes: what it changed in its copy of the folder, since the copy started. */
  changes?: Changes;
  /** A node that writes: the project's check, run in its copy when it ended. */
  check?: CommandResult;
  /** A grounding node's: the context it handed on, what each source gave, the tokens and what the budget left out. */
  grounding?: GroundResult;
  /**
   * A node that writes: where its commands came from (".kli/write.json", "bun.lock"…), and the fence they ran in
   * ("sandbox-exec: writes only in its copy, no network"), or why there was none.
   */
  project?: { source?: string; fence?: string; unfenced?: string };
}

/** The answers a person chooses from, each with its letter. */
export interface ChoiceRequest {
  node: string;
  request: string;
  options: { label: string; node: string; text: string }[];
  signal?: AbortSignal;
}

export interface StackResult {
  name: string;
  /** From the prompt to the last node: the slowest path through the graph. */
  ms: number;
  /** Every node, in the stack's order. */
  nodes: NodeResult[];
  /** The stack's answers: its output nodes, in order. */
  outputs: NodeResult[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The nodes' times added up: over `ms`, how much running them side by side saved. */
  nodeMs: number;
}

/** What happens in a stack while it runs, node by node. */
export type StackEvent =
  | { type: "start"; node: string; model: string }
  | { type: "delta"; node: string; text: string }
  | { type: "tool"; node: string; event: ToolEvent }
  /** What a node that writes does around its model: making its copy, the check. */
  | { type: "doing"; node: string; what: string }
  /** A node waits for the person to choose among these answers. */
  | { type: "asking"; node: string; options: { label: string; node: string }[] }
  | { type: "end"; node: string; result: NodeResult };

export interface StackOptions {
  signal?: AbortSignal;
  onEvent?: (event: StackEvent) => void;
  /** Asks the person which answer: the letter, or undefined when they did not choose. Without it, no person chooses. */
  ask?: (choice: ChoiceRequest) => Promise<string | undefined>;
}


/**
 * Runs a stack, prompt after prompt. Each node keeps its own conversation, so on the next prompt each one goes on
 * from what it said; a node's tools only read, so nodes running at the same time never ask the person anything.
 */
export class StackRunner {
  private readonly sessions = new Map<string, Session>();
  private readonly workspaces: Workspace[] = [];
  /**
   * Where each node that writes works, with the project's commands: the person's folder, when it is the stack's only
   * one (for the whole session), or its copy of the folder, for one round (until a change is applied, or none).
   */
  private readonly copies = new Map<string, { copy: Copy | Here; commands: ProjectCommands; fence: Fence | { none: string } }>();
  /** The nodes that changed files in this round's copies. */
  private readonly changed = new Set<string>();
  /** Kli's own git, where what the nodes changed is measured: made with the round's first copy, and gone with them. */
  private snapshots?: Promise<{ snapshots: Snapshots; repo?: Repo }>;
  /** The last round's copies going away: the next round's are made where they were, so they wait for it. */
  private dropping: Promise<void> = Promise.resolve();

  constructor(
    private readonly router: Router,
    private readonly trace: Trace,
    readonly name: string,
    readonly stack: StackConfig,
    private readonly options: {
      /** The config's instructions, for every node. */
      instructions?: string;
      /** Where kli runs: the nodes' tools read there. Without it, no node gets tools. */
      root?: string;
      /** The config's data sources, for the grounding nodes. */
      sources?: Record<string, SourceConfig>;
      /** The config's triage model, read at each message (the person can change it): with the stack's `purpose`, it says which messages the stack takes. */
      triage?: () => string | undefined;
    } = {},
  ) {
    this.sources = new Sources(options.sources);
  }

  /** What one model answered outside the stack: every node gets it with its next prompt, so the conversation is one. */
  private readonly heard: string[] = [];

  /** Whether a triage reads each message before the stack runs: the config names its model, and the stack its purpose. */
  get triages(): boolean {
    return !!this.options.triage?.() && !!this.stack.purpose?.trim();
  }

  /**
   * Asks the triage model whether `text` asks for the stack's work; undefined when the stack has no triage. Its
   * request and answer go to the trace with the stack's tags (node "triage"), and its decision as a `triage` event.
   */
  async triage(text: string, before?: Exchange, signal?: AbortSignal): Promise<TriageResult | undefined> {
    if (!this.triages) return undefined;
    const r = await triage(this.router, this.options.triage!()!, this.stack.purpose!, text, before, this.trace.tagged({ stack: this.name, node: "triage" }), signal);
    this.trace.record({ type: "triage", model: r.model, route: r.route, ms: r.ms, ...(r.why && { why: r.why }), ...(r.error && { error: r.error }), content: text }, { stack: this.name });
    return r;
  }

  /**
   * A first call to the triage model, in the background, when the session opens: a model on another machine opens
   * its tunnel and loads itself now, not on the person's first message (the first one took 6.6 s, the next 1.0 s).
   * It decides nothing and stays out of the trace: it is not a question, and every Kli that opens would leave an empty
   * session behind. A failure is left to the real triage.
   */
  warmTriage(): void {
    const quiet = { id: this.trace.id, file: this.trace.file, record: () => {} };
    if (this.triages) void triage(this.router, this.options.triage!()!, this.stack.purpose!, "hi", undefined, quiet).catch(() => {});
  }

  /** One model answered the person outside the stack (the triage sent the message there): the nodes hear of it. */
  note(exchange: Exchange): void {
    const text = heardNote(exchange);
    this.heard.push(text);
    for (const s of this.sessions.values()) s.note(text);
  }

  /** The data sources, opened once for the session: a source keeps the files it already cut. */
  private readonly sources: Sources;

  get id(): string {
    return this.trace.id;
  }

  /** Where the copies of this session's nodes go: next to its trace, and the diffs stay there when they go away. */
  private get copiesDir(): string {
    return this.trace.file.replace(/\.jsonl$/, "") + ".copies";
  }

  /** A node's conversation; one that writes works in the folder inside its copy, with the project's commands. */
  private session(id: string, node: StackNode, copy?: { root: string; run: string[]; check?: string; fence?: Fence; inFolder: boolean }): Session {
    let s = this.sessions.get(id);
    if (s) return s;
    let workspace: Workspace | undefined;
    const tools = toolsOf(node);
    const run = copy?.run ?? [];
    // the project's check said by name, in the note and in each refusal: a small model refused `bun test` kept asking
    // for it instead of the `npm test` that ran the same tests (23/11/2026)
    const commands = `the ones that only read${run.length ? `, and the ones that start with ${run.join(", ")}` : ""}${copy?.check ? `; the project's tests run with ${copy.check}` : ""}`;
    if (this.options.root && (tools === "read" || (tools === "write" && copy))) {
      workspace = new Workspace(copy?.root ?? this.options.root);
      // nodes run side by side and never ask: to read, plan mode; to write, any edit inside its own copy, and only
      // the commands that read or that the stack allows
      workspace.mode = tools === "write" ? "acceptEdits" : "plan";
      if (tools === "write") {
        workspace.rules.push(...allowedRules(run));
        workspace.fence = copy?.fence;
        workspace.alone = `no one is asked in a stack's step. The commands that run here: ${commands}`;
      }
      this.workspaces.push(workspace);
    }
    // small models take "write a text" for "write a file": what the tools can do here is said
    const note = !workspace
      ? undefined
      : tools === "write"
        ? `${copy?.inFolder ? "In this step you work in the person's own folder: make the changes the request needs to the files (Write, Edit); they are the project's files, and the person sees what you changed." : "In this step you work in a copy of the project that is only yours: make the changes the request needs to the files (Write, Edit). The person sees what you changed and chooses which changes to apply."} Commands: ${commands}. Any other is refused, and so is changing files outside the ${copy?.inFolder ? "folder" : "copy"}.\n\n${pace()}`
        : "In this step your tools only read: you cannot create or change files or run commands that change anything. Give your whole answer in your reply.";
    // the config's instructions are for answering the person (who Kli is, how it talks): a node that judges or chooses
    // answers Kli, and took them for requirements of the request
    const role = node.role ?? "answer";
    const general = role === "verify" || role === "choose" ? undefined : this.options.instructions;
    const instructions = [general, note, node.instructions].filter(Boolean).join("\n\n") || undefined;
    s = new Session(this.router, this.trace.tagged({ stack: this.name, node: id }), instructions, workspace);
    for (const n of this.heard) s.note(n);
    this.sessions.set(id, s);
    return s;
  }

  async send(text: string, options: StackOptions = {}): Promise<StackResult> {
    const { signal } = options;
    // a round no one closed (nothing applied, nothing said): each request is a round of its own
    await this.discard();
    const order = stackOrder(this.stack);
    this.trace.record({ type: "prompt", content: text });
    this.trace.record({ type: "stack", name: this.name, phase: "start", nodes: order });
    const started = performance.now();
    const results = new Map<string, Promise<NodeResult>>();
    const run = (id: string): Promise<NodeResult> => {
      let r = results.get(id);
      if (!r) results.set(id, (r = this.node(id, text, run, options)));
      return r;
    };
    const nodes = await Promise.all(order.map(run));
    const ms = Math.round(performance.now() - started);
    const result = this.summary(nodes, ms);
    this.trace.record({ type: "stack", name: this.name, phase: "end", ms, ok: result.outputs.some((o) => o.status === "ok"), ...(signal?.aborted && { interrupted: true }) });
    if (signal?.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError", result });
    return result;
  }

  /** The stack's result: its nodes, its outputs, and their measures added up. */
  private summary(nodes: NodeResult[], ms: number): StackResult {
    const order = stackOrder(this.stack);
    const outputs = stackOutputs(this.stack).map((id) => nodes[order.indexOf(id)]!);
    const result: StackResult = { name: this.name, ms, nodes, outputs, nodeMs: nodes.reduce((t, n) => t + n.ms, 0) };
    for (const key of ["inputTokens", "outputTokens", "costUsd"] as const)
      if (nodes.some((n) => n[key] !== undefined)) result[key] = nodes.reduce((t, n) => t + (n[key] ?? 0), 0);
    return result;
  }

  /** A node ends: its result goes to the trace, and to the screen. */
  private finish(r: NodeResult, onEvent?: StackOptions["onEvent"]): NodeResult {
    const tags = this.trace.tagged({ stack: this.name, node: r.node });
    tags.record({
      type: "node",
      model: r.answeredBy ?? r.model,
      status: r.status,
      ms: r.ms,
      steps: r.steps,
      tools: r.tools.length,
      toolFailures: r.tools.filter((t) => !t.ok).length,
      ...(r.tools.some((t) => t.refused) && { refused: r.tools.filter((t) => t.refused).length }),
      ...(r.firstTokenMs !== undefined && { firstTokenMs: r.firstTokenMs }),
      ...(r.inputTokens !== undefined && { inputTokens: r.inputTokens }),
      ...(r.outputTokens !== undefined && { outputTokens: r.outputTokens }),
      ...(r.costUsd !== undefined && { costUsd: r.costUsd }),
      ...(r.error && { error: r.error }),
      ...(r.contributions && { contributions: r.contributions }),
      ...(r.verdict && { verdict: { requirements: r.verdict.requirements, judged: r.verdict.judged.map(({ node, adherence, items }) => ({ node, adherence, items })) } }),
      ...(r.rounds && { rounds: r.rounds }),
      ...(r.choice && { choice: r.choice }),
      ...(r.changes && { changes: { files: r.changes.files.length, added: r.changes.added, removed: r.changes.removed, ...(r.changes.patchFile && { patch: r.changes.patchFile }) } }),
      ...(r.check && { check: { command: r.check.command, ok: r.check.ok, code: r.check.code, ms: r.check.ms } }),
      ...(r.project && { project: r.project }),
      ...(r.text && { content: r.text }),
      // how much of it the next nodes got (a CLI's last message), when not all
      ...(r.answer && { answerChars: r.answer.length }),
    });
    // what a grounding node handed on: where each excerpt came from (the query is content, left out without it)
    if (r.grounding)
      tags.record({
        type: "ground",
        sources: r.grounding.sources,
        excerpts: r.grounding.items.map((it) => ({ source: it.source, ref: it.ref, ...(it.relevance !== undefined && { relevance: it.relevance }) })),
        tokens: r.grounding.tokens,
        cut: r.grounding.cut,
        content: r.grounding.query,
      });
    onEvent?.({ type: "end", node: r.node, result: r });
    return r;
  }

  /** One node: waits for its inputs, then asks its model, measuring as it goes. */
  private async node(id: string, request: string, run: (id: string) => Promise<NodeResult>, options: StackOptions): Promise<NodeResult> {
    const { signal, onEvent, ask } = options;
    const node = this.stack.nodes[id]!;
    const role = node.role ?? "answer";
    // a judge does not wait for the slowest answer: it judges them as they come
    if (role === "verify") return this.judge(id, node, request, run, options);
    const inputs = await Promise.all((node.from ?? []).map(run));
    const base: NodeResult = { node: id, role, model: nodeModel(node), status: "skipped", text: "", ms: 0, steps: 0, tools: [] };
    const finish = (r: NodeResult) => this.finish(r, onEvent);

    const answered = inputs.filter((r) => r.status === "ok");
    // a stack does not stop (Alexandre, 12/11/2026): a step whose inputs did not answer runs all the same, with what
    // they said before they stopped, and does the rest itself; only a chooser has nothing to do without answers
    if (role === "choose" && answered.length < (node.min ?? 1)) {
      const missing = inputs.filter((r) => r.status !== "ok").map((r) => r.node);
      return finish({ ...base, error: `${answered.length} of ${inputs.length} inputs answered (${missing.join(", ")} did not)` });
    }
    if (signal?.aborted) return finish({ ...base, status: "interrupted" });

    // a grounding node passes through: what it got goes on, with its context; one whose sources all failed goes on
    // saying so, and its mode still holds (in restrict, nothing is answered from outside the sources)
    const grounds = inputs
      .filter((r) => r.role === "ground" && r.status === "failed")
      .map((r) => {
        const g = this.stack.nodes[r.node]!;
        const grounding = r.grounding ?? { mode: g.mode ?? "enrich", ...(g.rules?.trim() && { rules: g.rules.trim() }), sources: [], items: [], query: request, tokens: 0, cut: 0 };
        return { ...r, grounding: { ...grounding, unreachable: r.error ?? "it failed" } };
      });
    const { results: through, groundings } = await this.through([...answered, ...grounds], run);
    if (role === "ground") return finish(await this.ground(id, node, request, through, base, signal, onEvent));

    // each answer it gets has a letter, by its place in "from" (through the grounding nodes, in theirs): the model
    // never sees which model wrote it; an answer that changed files carries its diff and its check
    const places = this.places(node.from ?? []);
    const answers = through.map((r) => ({
      label: LETTERS[places.indexOf(r.node)] ?? r.node,
      node: r.node,
      plain: handed(r),
      text: r.changes ? withChanges(handed(r), r.changes, r.check) : handed(r),
      changed: !!r.changes,
      tools: toolLabels(r),
      ...(r.changes && { size: sizeOf(r) }),
    }));
    if (role === "choose") return finish(await this.choose(id, node, request, answers, groundings, { base, signal, onEvent, ask }));
    // the inputs that did not answer: what one said before it failed goes on, marked unfinished; the others by letter
    const unanswered = inputs.filter((r) => r.status !== "ok" && r.role !== "ground");
    const unfinished = unanswered
      .filter((r) => r.status === "failed" && handed(r).trim())
      .map((r) => ({ label: LETTERS[places.indexOf(r.node)] ?? r.node, node: r.node, text: handed(r), unfinished: "its step failed before it ended" }));
    const silent = unanswered.filter((r) => !unfinished.some((u) => u.node === r.node)).map((r) => LETTERS[places.indexOf(r.node)] ?? r.node);
    const given = [...answers, ...unfinished].sort((a, b) => a.label.localeCompare(b.label));
    const labels = Object.fromEntries(given.map((a) => [a.label, a.node]));
    const prompt = !node.from?.length ? request : role === "aggregate" ? aggregatePrompt(request, given, groundings, silent) : joinPrompt(request, given, groundings, silent);
    onEvent?.({ type: "start", node: id, model: nodeModel(node) });
    // a node that writes gets its copy first (made the first time it answers in a round); its time starts after
    let copy: Copy | Here | undefined;
    let commands: ProjectCommands | undefined;
    let fence: Fence | { none: string } | undefined;
    if (toolsOf(node) === "write" && this.options.root)
      try {
        ({ copy, commands, fence } = await this.copy(id, onEvent));
        // its copy is made: from here on it is the model's time again
        if (copy instanceof Copy) onEvent?.({ type: "doing", node: id, what: WAITING });
      } catch (e) {
        return finish({ ...base, status: signal?.aborted ? "interrupted" : "failed", error: (e as Error).message });
      }
    // in the folder, what it changes is measured from how the folder is now
    if (copy instanceof Here) await copy.mark();
    const started = performance.now();
    let firstTokenMs: number | undefined;
    const tools: NodeResult["tools"] = [];
    let model = nodeModel(node);
    // an aggregator's contributions block is for Kli: it never reaches the screen, not even while it comes
    const cut = role === "aggregate" ? contributionsCut() : undefined;
    // what it said, kept for when it fails: the steps after it get it, marked unfinished
    let said = "";
    const show = (t: string) => {
      if (!t) return;
      firstTokenMs ??= Math.round(performance.now() - started);
      said += t;
      onEvent?.({ type: "delta", node: id, text: t });
    };
    try {
      const session = this.session(id, node, copy && { root: copy.root, run: commands?.run ?? [], ...(commands?.check && { check: commands.check }), ...(fence instanceof Fence && { fence }), inFolder: copy instanceof Here });
      // in full ("vertex" is vertex/google/gemini-…), so a fallback shows as another name
      model = session.use(node.model!);
      const options = {
        signal,
        fallback: node.fallback ?? [],
        onDelta: (t: string) => show(cut ? cut.push(t) : t),
        onTool: (e: ToolEvent) => {
          if (e.phase === "end") tools.push({ name: e.call.name, label: e.label, ok: e.result!.ok, ...(e.result!.denied && { refused: true }) });
          onEvent?.({ type: "tool", node: id, event: e });
        },
      };
      const r = await session.send(prompt, options);
      if (cut) show(cut.end());
      let text = r.text;
      // a CLI's last message, without the narration of its steps, is what the next nodes get
      let answer = r.final;
      let contributions: Record<string, number> | undefined;
      if (role === "aggregate") {
        const read = readContributions(r.text);
        text = read.text;
        if (answer) answer = readContributions(answer).text;
        if (read.shares) contributions = Object.fromEntries(Object.entries(read.shares).filter(([l]) => labels[l]).map(([l, v]) => [labels[l]!, v]));
      }
      const ms = Math.round(performance.now() - started);
      const after = firstTokenMs !== undefined ? ms - firstTokenMs : 0;
      // what it changed in its copy, and the project's check there (not counted in its time)
      let changes: Changes | undefined;
      let check: CommandResult | undefined;
      if (copy) changes = await copy.changes();
      if (copy && changes) {
        if (changes.patch) changes.patchFile = copy.savePatch(changes);
        if (changes.files.length && copy instanceof Copy) this.changed.add(id);
        // a copy with no change is the folder as it was: its check says nothing about this node, and the project's
        // tests can take a while (a judge that needs it runs it once, below)
        const command = commands?.check;
        if (command && changes.files.length && !signal?.aborted) {
          onEvent?.({ type: "doing", node: id, what: `checking: ${command}` });
          check = await runIn(copy.root, command, signal, fence instanceof Fence ? fence : undefined);
        }
      }
      return finish({
        ...base,
        model,
        status: "ok",
        answeredBy: r.ref,
        text,
        ...(answer && answer !== text && { answer }),
        ...(contributions && { contributions }),
        ...(changes && { changes }),
        ...(check && { check }),
        ...(commands && {
          project: {
            ...(commands.source && { source: commands.source }),
            ...(fence instanceof Fence ? { fence: fence.describe(copy instanceof Here ? "the folder" : undefined) } : fence && { unfenced: fence.none }),
          },
        }),
        ms,
        steps: r.steps,
        tools,
        ...(firstTokenMs !== undefined && { firstTokenMs }),
        ...(r.inputTokens !== undefined && { inputTokens: r.inputTokens }),
        ...(r.outputTokens !== undefined && { outputTokens: r.outputTokens }),
        // the speed of the text, only when it can be measured: thinking comes before the text, a tool step's tokens
        // (Kli's or a CLI's own) are not text, and a text that came in one piece has no time to divide by
        ...(r.outputTokens && r.steps === 1 && !tools.length && after >= MIN_SPEED_MS && r.outputTokens > (r.thinkingTokens ?? 0) && {
          tokensPerSecond: Math.round(((r.outputTokens - (r.thinkingTokens ?? 0)) / after) * 1000 * 10) / 10,
        }),
        ...(r.thinkingTokens && { thinkingTokens: r.thinkingTokens }),
        ...(r.costUsd !== undefined && { costUsd: r.costUsd }),
      });
    } catch (e) {
      const ms = Math.round(performance.now() - started);
      const status: NodeStatus = signal?.aborted ? "interrupted" : "failed";
      const error = e instanceof ProviderError ? `${e.provider}: ${e.message}` : (e as Error).message;
      // what it changed before it failed or was stopped is still its work: measured and kept, so the person can apply
      // it (marked as such), and its diff stays next to the trace
      let changes: Changes | undefined;
      let check: CommandResult | undefined;
      if (copy)
        try {
          changes = await copy.changes();
          if (changes?.patch) changes.patchFile = copy.savePatch(changes);
          if (changes?.files.length && copy instanceof Copy) this.changed.add(id);
          // what it left is judged as unfinished work: the project's check says how it stands (not after Esc)
          const command = commands?.check;
          if (command && changes?.files.length && !signal?.aborted) {
            onEvent?.({ type: "doing", node: id, what: `checking what it left: ${command}` });
            check = await runIn(copy.root, command, signal, fence instanceof Fence ? fence : undefined);
          }
        } catch {}
      return finish({
        ...base,
        model,
        status,
        ...(said.trim() && { text: said }),
        ms,
        tools,
        ...(firstTokenMs !== undefined && { firstTokenMs }),
        ...(status === "failed" && { error }),
        ...(changes && { changes }),
        ...(check && { check }),
        ...(commands?.source && { project: { source: commands.source } }),
      });
    }
  }

  /**
   * The judge does not wait for the slowest answer (the Antigravity held one for ten minutes after the others had
   * ended, 02/11/2026). Once `min` of its inputs answered (1, by default), it judges the ones that came; then, in
   * rounds, each one that comes while it judges or after. A later round marks the requirements of the first, and only
   * those, and the judge's conversation goes on from round to round, so it still has the earlier answers before it.
   * Stopped (Esc), or failing in a later round, it keeps the verdict of the rounds it ended.
   */
  private async judge(id: string, node: StackNode, request: string, run: (id: string) => Promise<NodeResult>, { signal, onEvent }: StackOptions): Promise<NodeResult> {
    const from = node.from ?? [];
    const base: NodeResult = { node: id, role: "verify", model: nodeModel(node), status: "skipped", text: "", ms: 0, steps: 0, tools: [] };
    const finish = (r: NodeResult) => this.finish(r, onEvent);
    // the inputs as they end; `more` waits until the next one does
    const ended = new Map<string, NodeResult>();
    let ring: (() => void) | undefined;
    for (const f of from)
      void run(f)
        .catch((e: Error): NodeResult => ({ ...base, node: f, role: this.stack.nodes[f]?.role ?? "answer", status: "failed", error: e.message }))
        .then((r) => {
          ended.set(f, r);
          ring?.();
        });
    const allEnded = () => ended.size === from.length;
    const more = () => new Promise<void>((resolve) => (allEnded() ? resolve() : (ring = resolve)));
    const answered = () => from.map((f) => ended.get(f)).filter(judgeable);

    const min = node.min ?? 1;
    while (answered().length < min && !allEnded()) await more();
    if (answered().length < min) {
      const missing = from.filter((f) => !judgeable(ended.get(f)));
      return finish({ ...base, error: `${answered().length} of ${from.length} inputs answered (${missing.join(", ")} did not)` });
    }
    if (signal?.aborted) return finish({ ...base, status: "interrupted" });

    onEvent?.({ type: "start", node: id, model: nodeModel(node) });
    const places = this.places(from);
    const judged = new Set<string>();
    const tools: NodeResult["tools"] = [];
    const usage: { steps: number; inputTokens?: number; outputTokens?: number; costUsd?: number } = { steps: 0 };
    const add = (r: { steps: number; inputTokens?: number; outputTokens?: number; costUsd?: number }) => {
      usage.steps += r.steps;
      for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) if (r[key] !== undefined) usage[key] = (usage[key] ?? 0) + r[key]!;
    };
    let verdict: Verdict | undefined;
    /** Every answer it got, round after round: the sizes of their changes go side by side in each round. */
    const seen: Answer[] = [];
    let rounds = 0;
    let ms = 0;
    let firstTokenMs: number | undefined;
    let text = "";
    let model = nodeModel(node);
    let answeredBy: string | undefined;
    let error: string | undefined;
    try {
      const session = this.session(id, node);
      model = session.use(node.model!);
      for (;;) {
        const fresh = answered().filter((r) => !judged.has(r.node));
        if (!fresh.length) {
          if (allEnded() || signal?.aborted) break;
          const done = verdict ? verdict.judged.map((j) => j.node).join(", ") : "";
          onEvent?.({ type: "doing", node: id, what: `judged ${done} · waits for ${from.filter((f) => !ended.has(f)).join(", ")}` });
          await more();
          continue;
        }
        for (const r of fresh) judged.add(r.node);
        // each answer by its letter, through the grounding nodes on the way; one that changed files carries its diff
        const { results, groundings } = await this.through(fresh, run);
        const before = new Set(verdict?.judged.map((j) => j.node));
        const answers = results
          .filter((r) => !before.has(r.node))
          .map((r) => ({
            label: LETTERS[places.indexOf(r.node)] ?? r.node,
            node: r.node,
            text: r.changes ? withChanges(handed(r), r.changes, r.check) : handed(r),
            changed: !!r.changes,
            tools: toolLabels(r),
            ...(r.changes && { size: sizeOf(r) }),
            ...(r.status === "failed" && { unfinished: `its step failed: ${r.error ?? "no reason given"}` }),
          }));
        if (!answers.length) continue;
        seen.push(...answers);
        const labels = Object.fromEntries(answers.map((a) => [a.label, a.node]));
        // the first round reads the requirements in the request; the ones after mark those, and only those
        const later = verdict?.requirements;
        if (later) onEvent?.({ type: "doing", node: id, what: `judging ${answers.map((a) => a.node).join(", ")}` });
        const started = performance.now();
        const options = {
          signal,
          fallback: node.fallback ?? [],
          // a verdict is not an answer: it is read at the end, not shown as it comes
          onDelta: (t: string) => {
            if (t) firstTokenMs ??= Math.round(ms + performance.now() - started);
          },
          onTool: (e: ToolEvent) => {
            if (e.phase === "end") tools.push({ name: e.call.name, label: e.label, ok: e.result!.ok, ...(e.result!.denied && { refused: true }) });
            onEvent?.({ type: "tool", node: id, event: e });
          },
        };
        let r = await session.send(verifyPrompt(request, answers, later ?? node.requirements, groundings, !!later, seen), options);
        add(r);
        let read = readVerdict(r.final ?? r.text, labels, later ?? node.requirements, !!later);
        // once more, when it did not come in the shape asked
        if (!read && !signal?.aborted) {
          r = await session.send("Reply with the JSON only, in the shape asked, nothing else.", options);
          add(r);
          read = readVerdict(r.final ?? r.text, labels, later ?? node.requirements, !!later);
        }
        ms += Math.round(performance.now() - started);
        answeredBy = r.ref;
        text = r.text;
        rounds++;
        if (!read) throw new Error(`its verdict${later ? ` of ${answers.map((a) => a.node).join(", ")}` : ""} did not come in the shape asked, twice: adherence not measured`);
        verdict = verdict ? { requirements: verdict.requirements, judged: [...verdict.judged, ...read.judged] } : read;
      }
    } catch (e) {
      if (!signal?.aborted) error = e instanceof ProviderError ? `${e.provider}: ${e.message}` : (e as Error).message;
    }
    // the check of the answers it judged (the project's, the same in every copy); the ones that changed no file share
    // the folder's own result, run once now, in one of their copies
    if (verdict && !signal?.aborted) {
      const { results } = await this.through(answered().filter((r) => judged.has(r.node)), run);
      const check = results.find((i) => i.check)?.check?.command;
      if (check) {
        const unchanged = results.filter((i) => i.changes && !i.changes.files.length && !i.check);
        let folder: boolean | undefined;
        const at = unchanged.length ? this.copies.get(unchanged[0]!.node) : undefined;
        if (at) {
          onEvent?.({ type: "doing", node: id, what: `checking the folder as it was: ${check}` });
          folder = (await runIn(at.copy.root, check, signal, at.fence instanceof Fence ? at.fence : undefined)).ok;
        }
        verdict = withCheck(verdict, check, Object.fromEntries(results.map((i) => [i.node, i.check?.ok ?? (unchanged.includes(i) ? folder : undefined)])));
      }
    }
    return finish({
      ...base,
      model,
      status: signal?.aborted ? "interrupted" : error ? "failed" : "ok",
      ...(answeredBy && { answeredBy }),
      text,
      ...(verdict && { verdict }),
      ...(rounds > 1 && { rounds }),
      ...(error && { error }),
      ms,
      steps: usage.steps,
      tools,
      ...(firstTokenMs !== undefined && { firstTokenMs }),
      ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
      ...(usage.costUsd !== undefined && { costUsd: usage.costUsd }),
    });
  }

  /**
   * A node that chooses: it tries who `by` names, in order, until one chooses. The chosen answer becomes this node's,
   * and the nodes that answered go on, on the next prompt, from it instead of their own.
   */
  private async choose(
    id: string,
    node: StackNode,
    request: string,
    answers: (Answer & { node: string; plain: string })[],
    groundings: Grounding[],
    { base, signal, onEvent, ask }: { base: NodeResult; signal?: AbortSignal; onEvent?: StackOptions["onEvent"]; ask?: StackOptions["ask"] },
  ): Promise<NodeResult> {
    const labels = Object.fromEntries(answers.map((a) => [a.label, a.node]));
    const started = performance.now();
    const passed: string[] = [];
    let chosen: NonNullable<NodeResult["choice"]> | undefined;
    let usage: { model?: string; answeredBy?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; steps: number } = { steps: 0 };
    onEvent?.({ type: "start", node: id, model: nodeModel(node) });
    for (const by of node.by ?? ["model"]) {
      if (signal?.aborted) break;
      if (by === "decision") {
        passed.push("decision: no decision model yet");
        continue;
      }
      if (by === "person") {
        if (!ask) {
          passed.push("person: no one to ask here");
          continue;
        }
        onEvent?.({ type: "asking", node: id, options: answers.map(({ label, node }) => ({ label, node })) });
        const label = await ask({ node: id, request, options: answers.map(({ label, node, plain }) => ({ label, node, text: plain })), signal });
        if (label && labels[label]) {
          chosen = { node: labels[label]!, label, by };
          break;
        }
        passed.push("person: did not choose");
        continue;
      }
      // a model chooses, asked once more when its choice does not come in the shape asked
      try {
        const session = this.session(id, node);
        usage.model = session.use(node.model!);
        let r = await session.send(choosePrompt(request, answers, groundings), { signal, fallback: node.fallback ?? [] });
        let picked = readChoice(r.final ?? r.text, labels);
        const add = (x: typeof r) => {
          usage = { ...usage, answeredBy: x.ref, steps: usage.steps + x.steps, inputTokens: (usage.inputTokens ?? 0) + (x.inputTokens ?? 0), outputTokens: (usage.outputTokens ?? 0) + (x.outputTokens ?? 0) };
          if (x.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + x.costUsd;
        };
        add(r);
        if (!picked && !signal?.aborted) {
          r = await session.send("Reply with the JSON only, in the shape asked, nothing else.", { signal, fallback: node.fallback ?? [] });
          add(r);
          picked = readChoice(r.final ?? r.text, labels);
        }
        if (picked) {
          chosen = { ...picked, by };
          break;
        }
        passed.push("model: its choice did not come in the shape asked, twice");
      } catch (e) {
        if (signal?.aborted) break;
        passed.push(`model: ${e instanceof ProviderError ? `${e.provider}: ${e.message}` : (e as Error).message}`);
      }
    }
    const ms = Math.round(performance.now() - started);
    const measured = { model: usage.model ?? nodeModel(node), ms, steps: usage.steps, ...(usage.answeredBy && { answeredBy: usage.answeredBy }), ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }), ...(usage.costUsd !== undefined && { costUsd: usage.costUsd }) };
    if (signal?.aborted) return { ...base, ...measured, status: "interrupted" };
    if (!chosen) return { ...base, ...measured, status: "failed", error: `no one chose: ${passed.join("; ")}` };
    const text = answers.find((a) => a.node === chosen!.node)!.plain;
    onEvent?.({ type: "delta", node: id, text });
    // the conversation goes on from the chosen answer, in every node that answered
    for (const a of answers) this.sessions.get(a.node)?.rewriteLastAnswer(text);
    return { ...base, ...measured, status: "ok", text, choice: { ...chosen, ...(passed.length && { passed }) } };
  }

  /**
   * What a node gets through the grounding nodes before it: their context (each once, in the order met), and in place
   * of each grounding node the answers it got, so a grounding node between two steps adds and breaks nothing.
   */
  private async through(inputs: NodeResult[], run: (id: string) => Promise<NodeResult>, seen = new Set<string>()): Promise<{ results: NodeResult[]; groundings: Grounding[] }> {
    const results: NodeResult[] = [];
    const groundings: Grounding[] = [];
    for (const r of inputs) {
      if (r.role !== "ground") {
        if (!results.some((x) => x.node === r.node)) results.push(r);
        continue;
      }
      if (seen.has(r.node)) continue;
      seen.add(r.node);
      const before = (await Promise.all((this.stack.nodes[r.node]!.from ?? []).map(run))).filter((x) => x.status === "ok");
      const inner = await this.through(before, run, seen);
      groundings.push(...inner.groundings, ...(r.grounding ? [r.grounding] : []));
      for (const x of inner.results) if (!results.some((y) => y.node === x.node)) results.push(x);
    }
    return { results, groundings };
  }

  /** The nodes a node gets answers from, in order, with each grounding node replaced by the ones it gets from. */
  private places(from: string[], seen = new Set<string>()): string[] {
    return [
      ...new Set(
        from.flatMap((id) => {
          if (this.stack.nodes[id]?.role !== "ground") return [id];
          if (seen.has(id)) return [];
          seen.add(id);
          return this.places(this.stack.nodes[id]!.from ?? [], seen);
        }),
      ),
    ];
  }

  /** A grounding node: searches its sources with the request, the answers it got, or both, and hands on the context. */
  private async ground(id: string, node: StackNode, request: string, got: NodeResult[], base: NodeResult, signal?: AbortSignal, onEvent?: StackOptions["onEvent"]): Promise<NodeResult> {
    onEvent?.({ type: "start", node: id, model: nodeModel(node) });
    onEvent?.({ type: "doing", node: id, what: `searching ${(node.sources ?? []).join(", ")}` });
    const started = performance.now();
    const answers = got.map(handed).join("\n\n");
    const query = node.query === "answers" ? answers : node.query === "both" ? `${request}\n\n${answers}` : request;
    try {
      const grounding = await ground(node, query, this.sources, signal);
      const ms = Math.round(performance.now() - started);
      if (signal?.aborted) return { ...base, status: "interrupted", ms };
      // every source failed: there is no context to hand on
      if (grounding.sources.length && grounding.sources.every((s) => s.error)) return { ...base, status: "failed", ms, error: grounding.sources.map((s) => `${s.name}: ${s.error}`).join("; "), grounding };
      return { ...base, status: "ok", ms, grounding };
    } catch (e) {
      return { ...base, status: "failed", ms: Math.round(performance.now() - started), error: (e as Error).message };
    }
  }

  /**
   * Kli's own git for this round's copies (or for the folder of the only node that writes), made once. What a Kli
   * that died left in the sessions folder goes first, and this one's copies are marked as its own.
   */
  private store(): Promise<{ snapshots: Snapshots; repo?: Repo }> {
    this.snapshots ??= (async () => {
      const dir = this.copiesDir;
      await this.dropping;
      await removeLeftovers(dirname(dir), dir).catch(() => {});
      claimCopies(dir);
      const repo = await repoOf(this.options.root!);
      return { snapshots: await Snapshots.open(join(dir, ".snapshots"), repo), ...(repo && { repo }) };
    })().catch((e) => {
      this.snapshots = undefined;
      throw e;
    });
    return this.snapshots;
  }

  /**
   * Where the node works: its copy of the folder, made for this round the first time it answers in it, or the
   * person's folder, when it is the stack's only node that writes. The project's check and the commands it may run
   * come from the project (`projectCommands`), so the person never says them; the copy has the folder's dependencies
   * already, so nothing is set up.
   */
  private async copy(id: string, onEvent?: StackOptions["onEvent"]): Promise<{ copy: Copy | Here; commands: ProjectCommands; fence: Fence | { none: string } }> {
    const had = this.copies.get(id);
    if (had) return had;
    // the only node that writes has nothing to be compared with: it edits the person's folder, and the project's
    // check runs there
    if (writesInFolder(this.stack)) {
      const { snapshots, repo } = await this.store();
      const here = Here.at(this.options.root!, join(this.copiesDir, id), snapshots, repo);
      const commands = projectCommands(projectFolders(here.root, here.top ?? here.root), this.stack.write);
      const fence = Fence.for([here.top ?? here.root, ...(here.gitDir ? [here.gitDir] : [])], commands.fence);
      const entry = { copy: here, commands, fence };
      this.copies.set(id, entry);
      return entry;
    }
    onEvent?.({ type: "doing", node: id, what: "making its copy of the folder" });
    const { snapshots, repo } = await this.store();
    const copy = await Copy.make(this.options.root!, join(this.copiesDir, id), snapshots, repo);
    let commands: ProjectCommands;
    try {
      commands = projectCommands(projectFolders(copy.root, copy.path), this.stack.write);
    } catch (e) {
      await copy.remove();
      throw e;
    }
    // the copy has its own .git inside it: the node's git commands write there, and nowhere else
    const fence = Fence.for([copy.path], commands.fence);
    const entry = { copy, commands, fence };
    this.copies.set(id, entry);
    return entry;
  }

  /**
   * Applies a node's changes to the folder: the files it created, changed or deleted in its copy go there, and the
   * round ends, with every copy taken away (the applied one too). The nodes that write go on from that node's answer,
   * as after a choice. If the person changed one of those files in the folder meanwhile, nothing is applied, and the
   * round ends all the same; the diff stays next to the trace.
   */
  async apply(result: NodeResult): Promise<void> {
    if (!this.options.root || !result.changes?.files.length) throw new Error(`${result.node} changed no file`);
    if (result.changes.inFolder) throw new Error(`${result.node} changed your folder itself: there is nothing to apply`);
    const entry = this.copies.get(result.node);
    if (!(entry?.copy instanceof Copy)) throw new Error(`the copy of ${result.node} is gone: its round ended`);
    // what was left running in the copies stops first: nothing changes a file while it goes to the folder
    await this.stopInCopies();
    try {
      await entry.copy.apply(result.changes);
    } catch (e) {
      await this.discard();
      throw e;
    }
    const c = result.changes;
    this.trace.tagged({ stack: this.name, node: result.node }).record({ type: "apply", files: c.files.map((f) => f.path), added: c.added, removed: c.removed, ...(c.patchFile && { patch: c.patchFile }) });
    await this.dropCopies();
    for (const [id, s] of this.sessions) if (this.stack.nodes[id] && toolsOf(this.stack.nodes[id]) === "write") s.rewriteLastAnswer(handed(result));
  }

  /**
   * The round ends with no change applied (Esc, "none", nothing to choose, the next request): every copy goes away,
   * the folder stays as it was, and when a node had changed files, each node that writes hears it with its next
   * prompt. The only node that writes, in the folder, has no round to end.
   */
  async discard(): Promise<void> {
    if (writesInFolder(this.stack) || !this.copies.size) return;
    const changed = this.changed.size > 0;
    await this.dropCopies();
    if (changed) for (const [id, s] of this.sessions) if (this.stack.nodes[id] && toolsOf(this.stack.nodes[id]) === "write") s.note(NOTHING_APPLIED);
  }

  /** Stops the commands the nodes left running in their copies. */
  private async stopInCopies(): Promise<void> {
    const roots = [...this.copies.values()].map((c) => c.copy.root);
    await Promise.all(this.workspaces.filter((w) => roots.includes(w.root)).map((w) => w.close()));
  }

  /**
   * Takes the copies away, and Kli's own git with them (their diffs stay, next to the trace). The round is over at
   * once, so a request that comes meanwhile starts a new one; its copies wait until these are gone from the disk.
   */
  private dropCopies(): Promise<void> {
    const copies = [...this.copies.values()].map((c) => c.copy);
    const inCopies = this.workspaces.filter((w) => copies.some((c) => w.root === c.root));
    const store = this.snapshots;
    this.copies.clear();
    this.changed.clear();
    this.snapshots = undefined;
    this.dropping = this.dropping
      .then(async () => {
        await Promise.all(inCopies.map((w) => w.close()));
        await Promise.all(copies.map((c) => c.remove()));
        await store?.then(({ snapshots }) => snapshots.remove(), () => {});
      })
      .catch(() => {});
    return this.dropping;
  }

  /** Stops what the nodes left running in the background, and takes the copies away. */
  async close(): Promise<void> {
    await Promise.all(this.workspaces.map((w) => w.close()));
    await this.dropCopies();
  }
}
