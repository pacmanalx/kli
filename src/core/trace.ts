import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every step leaves a trace. One session = one JSONL file, one event per line. */
export type TraceEvent =
  /** `profile` only in sessions from before locations. */
  | { type: "start"; user: string; surface: string; profile?: string }
  | { type: "prompt"; content?: string }
  | { type: "request"; provider: string; model: string; messages: number }
  | {
      type: "response";
      provider: string;
      model: string;
      ms: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      content?: string;
    }
  | { type: "failure"; provider: string; model?: string; ms: number; error: string; afterText: boolean }
  /** The user interrupted (Ctrl+C): not a provider failure, and it never triggers the fallback. */
  | { type: "interrupted"; provider: string; model?: string; ms: number; afterText: boolean }
  | { type: "fallback"; from: string; to: string; reason: string }
  /** A tool the model used: `content` is its input (left out when the config keeps no content). */
  | { type: "tool"; name: string; detail: string; ok: boolean; ms: number; summary: string; content?: string }
  /** A command the person ran with ! (`content` is what it printed). */
  | { type: "shell"; command: string; code: number | null; ms: number; content?: string }
  /**
   * The triage read a message before a stack (with the stack's tag): `one` = one model answers it, `stack` = the stack
   * runs. `error` = the triage failed or its answer could not be read, so the stack runs; `content` is the message.
   */
  | { type: "triage"; model: string; route: "one" | "stack"; ms: number; why?: string; error?: string; content?: string }
  /** A stack took a prompt, and when it ended: `ok` = at least one of its outputs answered. */
  | { type: "stack"; name: string; phase: "start" | "end"; nodes?: string[]; ms?: number; ok?: boolean; interrupted?: boolean }
  /** One node of a stack ended; it goes with the node's tags, like the node's own requests, responses and tools. */
  | {
      type: "node";
      model: string;
      status: NodeStatus;
      ms: number;
      firstTokenMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      steps: number;
      tools: number;
      toolFailures: number;
      error?: string;
      /** An aggregator's: node → share of its answer. */
      contributions?: Record<string, number>;
      /** A verifier's: the requirements, and each judged node's marks and adherence. */
      verdict?: { requirements: string[]; judged: { node: string; adherence: number; items: string[] }[] };
      /** A chooser's: the answer it chose (node and letter), who chose it and why. */
      choice?: { node: string; label: string; by: string; why?: string; passed?: string[] };
      /** A node that writes: what it changed in its copy (the diff is in `patch`, a file next to the trace). */
      changes?: { files: number; added: number; removed: number; patch?: string };
      /** A node that writes: how the project's check ended in its copy. */
      check?: { command: string; ok: boolean; code: number | null; ms: number };
      /** A node that writes: where its check came from, and its fence (or why it had none); `setup` only in older traces. */
      project?: { source?: string; setup?: string; fence?: string; unfenced?: string };
      /** How many times it was refused something no one in a stack can allow (a command, a file outside). */
      refused?: number;
      /** What its provider said along the way (the server's context reached, calls written as text). */
      notice?: string;
      content?: string;
    }
  /** The person applied a node's changes to the folder; it goes with the node's tags. */
  | { type: "apply"; files: string[]; added: number; removed: number; patch?: string }
  /** What a grounding node handed on (with the node's tags): each source, each excerpt, the tokens; `content` is the query. */
  | {
      type: "ground";
      sources: { name: string; ms: number; found: number; kept: number; error?: string }[];
      excerpts: { source: string; ref: string; relevance?: number }[];
      tokens: number;
      cut: number;
      content?: string;
    };

export type NodeStatus = "ok" | "failed" | "skipped" | "interrupted";

/** What a stack's nodes add to each of their events. */
export interface EventTags {
  stack?: string;
  node?: string;
}

export type StoredEvent = TraceEvent & EventTags & { ts: string; session: string };

/** Where events go: a session's trace, or the same trace tagged with a stack's node. */
export type TraceSink = Pick<Trace, "id" | "file" | "record">;

export class Trace {
  readonly id: string;
  readonly file: string;
  /** The start event is only written together with the first real event, so an empty session leaves no file. */
  private pendingStart?: TraceEvent & { ts: string };

  constructor(
    private readonly dir: string,
    start: { user: string; surface: string },
    private readonly withContent = true,
    id = newSessionId(),
  ) {
    this.id = id;
    this.file = join(dir, `${id}.jsonl`);
    this.pendingStart = { type: "start", ...start, ts: new Date().toISOString() };
  }

  record(event: TraceEvent, tags?: EventTags): void {
    if (this.pendingStart) {
      mkdirSync(this.dir, { recursive: true });
      const { ts, ...start } = this.pendingStart;
      this.pendingStart = undefined;
      this.write(start, ts);
    }
    this.write(event, new Date().toISOString(), tags);
  }

  /** The same file, with `tags` on each event: what one node of a stack does. */
  tagged(tags: EventTags): TraceSink {
    return { id: this.id, file: this.file, record: (event, more) => this.record(event, { ...tags, ...more }) };
  }

  private write(event: TraceEvent, ts: string, tags?: EventTags): void {
    const line: Record<string, unknown> = { ts, session: this.id, ...tags, ...event };
    if (!this.withContent) delete line.content;
    appendFileSync(this.file, JSON.stringify(line) + "\n");
  }
}

/** Ids sort by local time: 20261030-143512-a1b2. */
export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${date}-${time}-${crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16).padStart(4, "0")}`;
}

export function readTrace(dir: string, id: string): StoredEvent[] {
  const file = join(dir, `${id}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as StoredEvent);
}

/** Session ids, most recently active first. */
export function listSessions(dir: string, limit = 20): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.slice(0, -".jsonl".length), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((s) => s.id);
}
