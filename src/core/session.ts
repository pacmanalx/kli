import { instructionsPrompt } from "./instructions.ts";
import type { AgentToolEvent } from "./providers/provider.ts";
import type { ChatOptions, RoutedResponse, Router } from "./router.ts";
import type { ToolResult, Workspace } from "./tools.ts";
import type { TraceSink } from "./trace.ts";
import type { Message, ToolCall } from "./types.ts";

/** A tool being used: when it starts (before any permission question), what a command prints, and when it ends. */
export interface ToolEvent {
  phase: "start" | "output" | "end";
  call: ToolCall;
  /** Read(src/x.ts), Bash(npm test). */
  label: string;
  /** A piece of a command's output, as it came ("output"). */
  output?: string;
  result?: ToolResult;
  /** A tool of the CLI agent (it ran it), not one of Kli's. */
  agent?: boolean;
}

export interface SendOptions extends ChatOptions {
  onTool?: (event: ToolEvent) => void;
}

/**
 * A session: the message history of one conversation, plus its trace. With a workspace, the model gets the tools:
 * it answers, asks for tools, gets their results, and goes on until it answers with text alone. Nothing counts its
 * steps or its time: it ends when the model does, or when the person stops it (Esc).
 */
export class Session {
  private readonly messages: Message[] = [];
  /** What the model should know with the next prompt: a command the person ran with !. */
  private notes: string[] = [];
  /** The model chosen for this session (`--model`); undefined = the config's. */
  model?: string;

  constructor(
    private readonly router: Router,
    readonly trace: TraceSink,
    instructions?: string,
    readonly workspace?: Workspace,
  ) {
    const env = workspace
      ? [
          "<env>",
          `Working directory: ${workspace.root}`,
          `Platform: ${process.platform}`,
          `Today: ${new Date().toISOString().slice(0, 10)}`,
          "</env>",
          "You have tools to read, search, create and edit files and to run commands in the working directory. Use them only when the request is about the files here or needs a command; answer questions and write texts (a summary, a letter, a poem) directly in your reply, without tools. Read a file before changing it; after creating or changing files, say which ones.",
        ].join("\n")
      : "";
    // the project's AGENTS.md and CLAUDE.md, read again for each new session
    const project = workspace ? instructionsPrompt(workspace.instructions()) : "";
    const system = [instructions, env, project].filter(Boolean).join("\n\n");
    if (system) this.messages.push({ role: "system", content: system });
  }

  get id(): string {
    return this.trace.id;
  }

  /** Switches the model for the next prompts ("location/provider/model"). Throws when the config has no such thing. */
  use(ref: string): string {
    this.model = this.router.target(ref).ref;
    return this.model;
  }

  /** A CLI agent's own tools (Claude Code, Antigravity…) go on screen and to the trace like Kli's. */
  private agentTool(onTool?: (event: ToolEvent) => void): (e: AgentToolEvent) => void {
    const started = new Map<string, number>();
    return (e) => {
      const call: ToolCall = { id: e.id, name: e.name, input: {} };
      if (e.phase === "start") {
        started.set(e.id, performance.now());
        onTool?.({ phase: "start", call, label: e.label, agent: true });
        return;
      }
      if (!started.has(e.id)) onTool?.({ phase: "start", call, label: e.label, agent: true });
      if (e.output) onTool?.({ phase: "output", call, label: e.label, output: e.output, agent: true });
      const result: ToolResult = { ok: e.ok ?? true, output: e.output ?? "", summary: e.summary ?? "", ...(e.refused && { denied: true }) };
      const ms = Math.round(performance.now() - (started.get(e.id) ?? performance.now()));
      this.trace.record({ type: "tool", name: e.name, detail: e.label, ok: result.ok, ms, summary: result.summary, ...(e.output && { content: e.output.slice(0, 2000) }) });
      onTool?.({ phase: "end", call, label: e.label, result, agent: true });
    };
  }

  /** Something the model gets with the next prompt, before the person's words. */
  note(text: string): void {
    this.notes.push(text);
  }

  /** Puts `text` in place of the last answer (a stack chose another one): the next prompt goes on from it. */
  rewriteLastAnswer(text: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--)
      if (this.messages[i]!.role === "assistant") {
        this.messages[i] = { role: "assistant", content: text };
        return;
      }
  }

  async send(text: string, options: SendOptions = {}): Promise<RoutedResponse & { steps: number }> {
    const { onTool, ...chat } = options;
    const start = this.messages.length;
    // what happened since the last prompt (a command the person ran, a background command that ended) goes first
    const notes = [...this.notes.splice(0), ...(this.workspace?.endedNotes() ?? [])];
    const content = notes.length ? `${notes.map((n) => `<note from="kli">\n${n}\n</note>`).join("\n")}\n\n${text}` : text;
    this.messages.push({ role: "user", content });
    this.trace.record({ type: "prompt", content: text });
    const started = performance.now();
    const totals = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costUsd: 0, counted: false, cost: false };
    const notices: string[] = [];
    try {
      for (let step = 1; ; step++) {
        const ws = this.workspace && { tools: this.workspace.specs(), workspace: { root: this.workspace.root, mode: this.workspace.mode }, onAgentTool: this.agentTool(onTool) };
        const r = await this.router.chat(this.messages, { model: this.model, ...chat, ...ws }, this.trace);
        if (r.inputTokens !== undefined) totals.counted = true;
        totals.inputTokens += r.inputTokens ?? 0;
        totals.outputTokens += r.outputTokens ?? 0;
        totals.thinkingTokens += r.thinkingTokens ?? 0;
        if (r.costUsd !== undefined) totals.cost = true;
        totals.costUsd += r.costUsd ?? 0;
        if (r.notice) notices.push(r.notice);
        this.messages.push({ role: "assistant", content: r.text, ...(r.toolCalls && { toolCalls: r.toolCalls }), ...(r.raw && { raw: r.raw }) });
        const sum = {
          ...r,
          ms: Math.round(performance.now() - started),
          steps: step,
          ...(totals.counted && { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens }),
          ...(totals.thinkingTokens && { thinkingTokens: totals.thinkingTokens }),
          ...(totals.cost && { costUsd: totals.costUsd }),
          ...(notices.length && { notice: [...new Set(notices)].join(" · ") }),
        };
        if (!r.toolCalls?.length || !this.workspace) return sum;
        let refused = false;
        for (const call of r.toolCalls) {
          // every call gets an answer, even the ones skipped after a refusal
          if (refused || chat.signal?.aborted) {
            this.messages.push({ role: "tool", content: "Not run: the person stopped this turn.", toolCallId: call.id, toolName: call.name });
            continue;
          }
          const label = this.workspace.label(call);
          onTool?.({ phase: "start", call, label });
          const t0 = performance.now();
          const result = await this.workspace.run(call, chat.signal, onTool && ((output) => onTool({ phase: "output", call, label, output })));
          this.trace.record({ type: "tool", name: call.name, detail: label, ok: result.ok, ms: Math.round(performance.now() - t0), summary: result.summary, content: JSON.stringify(call.input) });
          onTool?.({ phase: "end", call, label, result });
          this.messages.push({ role: "tool", content: result.output, toolCallId: call.id, toolName: call.name });
          if (result.refused) refused = true;
        }
        if (chat.signal?.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" });
        if (refused) return { ...sum, notice: [sum.notice, "stopped: you refused a tool"].filter(Boolean).join(" · ") };
      }
    } catch (e) {
      // A prompt without an answer stays out of the history, so the next attempt starts clean (with its notes).
      this.messages.splice(start);
      this.notes.unshift(...notes);
      throw e;
    }
  }
}
