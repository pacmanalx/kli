import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { KLI_DIR } from "../config.ts";
import { shellQuote, sshWhy } from "../tunnels.ts";
import { ProviderError, type HarnessProviderConfig, type Message } from "../types.ts";
import type { ChatRequest, ChatResponse, Provider } from "./provider.ts";

type Result = Omit<ChatResponse, "text"> & { text?: string; error?: string };
/** A step of a CLI agent's own tools, as its stream tells it (an end may carry only the id). */
type ToolStep = { phase: "start" | "end"; id: string; name?: string; input?: Record<string, unknown>; output?: string; ok?: boolean; exit?: number; refused?: boolean };
type Reading = { delta?: string; result?: Result; tools?: ToolStep[] };

const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
const parseJson = (s: unknown): Record<string, unknown> => {
  try {
    return typeof s === "string" ? JSON.parse(s) : ((s ?? {}) as Record<string, unknown>);
  } catch {
    return {};
  }
};

/** One line of a harness's stream-json, read into a piece of text or the final result. */
const READERS: Record<"claude" | "antigravity" | "opencode" | "kimi", (event: any) => Reading | undefined> = {
  claude: (e) => {
    if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta")
      return { delta: e.event.delta.text };
    // its tools: the whole call in the assistant's message, the result in the next user message
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      const tools = e.message.content.filter((c: any) => c.type === "tool_use").map((c: any): ToolStep => ({ phase: "start", id: c.id, name: c.name, input: c.input }));
      return tools.length ? { tools } : undefined;
    }
    if (e.type === "user" && Array.isArray(e.message?.content)) {
      const tools = e.message.content.filter((c: any) => c.type === "tool_result").map((c: any): ToolStep => ({ phase: "end", id: c.tool_use_id, output: text(c.content), ok: !c.is_error }));
      return tools.length ? { tools } : undefined;
    }
    if (e.type === "result") {
      const u = e.usage ?? {};
      const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      return {
        result: {
          text: typeof e.result === "string" ? e.result : undefined,
          inputTokens: e.usage ? input : undefined,
          outputTokens: u.output_tokens,
          costUsd: e.total_cost_usd,
          error: e.is_error ? String(e.result || e.subtype || "error") : undefined,
        },
      };
    }
  },
  antigravity: (e) => {
    const step = e.step_update;
    if (e.event === "step_update" && step?.step_type === "agent_response" && step.text_delta) return { delta: step.text_delta };
    // a tool step: ACTIVE when it starts, DONE (with the output) when it ends
    if (e.event === "step_update" && step?.step_type === "tool") {
      const id = `agy_${step.step_index}`;
      const input = step.tool_info?.parameters ?? {};
      if (step.state === "ACTIVE") return { tools: [{ phase: "start", id, name: step.tool_name, input }] };
      // a failed step says why only in its error: a command its rules did not allow, for one
      const why = String(step.tool_info?.error?.message ?? "");
      const raw = String(step.tool_info?.output ?? why);
      // a long output comes after a note on where agy kept all of it
      const exit = /^Command exited with code (\d+)/m.exec(raw);
      const output = raw.replace(/^Command exited with code \d+\.\s*(Command output:\s*)?/m, "");
      const refused = /^permission check failed/i.test(why);
      return { tools: [{ phase: "end", id, name: step.tool_name, input, output, ok: step.state === "DONE" && !step.tool_info?.error && (!exit || exit[1] === "0"), ...(exit && { exit: Number(exit[1]) }), ...(refused && { refused }) }] };
    }
    if (e.event === "result") {
      const r = e.result ?? {};
      const u = r.usage ?? {};
      // with -p, a permission no one gave ends the run there, as a success: what it said is only what it would do
      const denied: string[] = (r.denied_actions ?? []).map((a: any) => String(a?.display_name ?? a?.action ?? "an action"));
      return {
        result: {
          text: r.response,
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens !== undefined ? u.output_tokens + (u.thinking_tokens ?? 0) : undefined,
          ...(u.thinking_tokens && { thinkingTokens: u.thinking_tokens }),
          error:
            r.status && r.status !== "SUCCESS"
              ? `${r.status}${r.error ? `: ${r.error}` : ""}`
              : denied.length
                ? `stopped at a refused permission (${[...new Set(denied)].join(", ")}): agy ends the run there`
                : undefined,
        },
      };
    }
    if (e.event === "error") return { result: { error: e.error?.message ?? JSON.stringify(e.error ?? e) } };
  },
  // opencode run --format json: whole text parts, and the usage at the end of each step
  opencode: (e) => {
    if (e.type === "text" && typeof e.part?.text === "string") return { delta: e.part.text };
    // a tool arrives once, when it has ended
    if (e.type === "tool_use" && e.part?.state) {
      const st = e.part.state;
      const exit = st.metadata?.metadata?.exit ?? st.metadata?.exit;
      const step = { id: e.part.id ?? e.part.partID, name: e.part.tool, input: st.input ?? {} };
      return { tools: [{ phase: "start", ...step }, { phase: "end", ...step, output: String(st.output ?? st.error ?? ""), ok: st.status === "completed" && (exit === undefined || exit === 0), ...(typeof exit === "number" && { exit }) }] };
    }
    if (e.type === "step_finish" && e.part?.tokens)
      return { result: { inputTokens: e.part.tokens.input, outputTokens: e.part.tokens.output, costUsd: e.part.cost || undefined } };
    if (e.type === "error") return { result: { error: e.error?.data?.message ?? e.error?.message ?? JSON.stringify(e.error ?? e) } };
  },
  // kimi -p --output-format stream-json: one line per message; the meta lines (version, resume hint) are not the answer
  kimi: (e) => {
    if (e.role === "assistant" && Array.isArray(e.tool_calls) && e.tool_calls.length)
      return {
        ...(typeof e.content === "string" && e.content && { delta: e.content }),
        tools: e.tool_calls.map((c: any): ToolStep => ({ phase: "start", id: c.id, name: c.function?.name, input: parseJson(c.function?.arguments) })),
      };
    if (e.role === "tool" && e.tool_call_id) return { tools: [{ phase: "end", id: e.tool_call_id, output: text(e.content) }] };
    if (e.role === "assistant" && typeof e.content === "string" && e.content) return { delta: e.content };
    if (e.type === "error" || e.role === "error") return { result: { error: e.message ?? e.content ?? JSON.stringify(e) } };
  },
};

/**
 * A CLI agent's last message: the text after its last tool step (`cuts`: where the text stood at each step), or after
 * the one before when it ended on a tool. Undefined when that is all it said: then the text is the message. The
 * CLIs do not agree on a field for it: Claude Code's `result` is this, Antigravity's `response` is the whole text,
 * Kimi and OpenCode have none (measured on 06/11/2026).
 */
export function lastMessage(text: string, cuts: number[]): string | undefined {
  const bounds = [0, ...cuts, text.length];
  for (let i = bounds.length - 1; i > 0; i--) {
    const piece = text.slice(bounds[i - 1], bounds[i]).trim();
    if (piece) return piece === text.trim() ? undefined : piece;
  }
  return undefined;
}

/** The conversation as one prompt: a harness takes a single message per run. */
export function harnessPrompt(messages: Message[]): string {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  const earlier = turns.slice(0, -1);
  const parts: string[] = [];
  if (system) parts.push(`<instructions>\n${system}\n</instructions>`);
  // the tools other models used along the conversation are told as text
  const turn = (m: Message) =>
    m.role === "tool"
      ? `Tool ${m.toolName ?? ""} result: ${m.content}`
      : `${m.role === "user" ? "User" : "Assistant"}: ${m.content}${(m.toolCalls ?? []).map((c) => `\n[used ${c.name} ${JSON.stringify(c.input)}]`).join("")}`;
  if (earlier.length) parts.push(`<conversation>\n${earlier.map(turn).join("\n\n")}\n</conversation>`);
  parts.push(turns.at(-1)?.content ?? "");
  return parts.join("\n\n");
}

/**
 * The arguments with the prompt and the model in place. With no model, the "{model}" argument and the flag before
 * it are left out, so the CLI uses its own default.
 */
export function harnessArgs(template: string[], prompt: string, model: string, mode: string[] = []): string[] {
  const args: string[] = [];
  for (const a of template) {
    if (a === "{mode}") {
      args.push(...mode);
      continue;
    }
    if (!model && a.includes("{model}")) {
      if (args.at(-1)?.startsWith("-")) args.pop();
      continue;
    }
    args.push(a.replaceAll("{prompt}", prompt).replaceAll("{model}", model));
  }
  return args;
}

/** The CLIs' names for their tools, in Claude Code's words, so they look the same on screen. */
const TOOL_NAMES: Record<string, string> = {
  run_command: "Bash", shell: "Bash", bash: "Bash", write_file: "Write", write_to_file: "Write", write: "Write", view_file: "Read", read_file: "Read", read: "Read",
  replace_file_content: "Edit", multi_replace_file_content: "Edit", edit_file: "Edit", edit: "Edit", list_dir: "LS", list: "LS", ls: "LS", glob: "Glob", find_by_name: "Glob",
  grep: "Grep", grep_search: "Grep", web_fetch: "WebFetch", webfetch: "WebFetch", read_url_content: "WebFetch", search_web: "WebSearch", todowrite: "TodoWrite",
};
const ARGUMENT = ["command", "CommandLine", "file_path", "filePath", "path", "Path", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "pattern", "Pattern", "Query", "query", "url", "Url", "description"];

/** A CLI's tool step for the screen: Bash(ls -la), Write(oi.txt); paths relative to the folder. */
export function agentTool(step: ToolStep, root?: string): { name: string; label: string; summary?: string } {
  // an MCP tool, named as in Claude Code: qdrant-rag - search_rag (MCP)
  const mcp = step.name === "call_mcp_tool" && typeof step.input?.ServerName === "string" ? step.input : undefined;
  const name = mcp ? `${mcp.ServerName} - ${mcp.ToolName} (MCP)` : (TOOL_NAMES[step.name ?? ""] ?? TOOL_NAMES[(step.name ?? "").toLowerCase()] ?? step.name ?? "tool");
  const input = mcp ? ((mcp.Arguments ?? {}) as Record<string, unknown>) : step.input;
  const key = mcp ? Object.keys(input ?? {}).find((k) => typeof input![k] === "string") : ARGUMENT.find((k) => typeof input?.[k] === "string" && input[k]);
  let arg = key ? String(input![key]) : "";
  if (arg.startsWith("/")) {
    const rel = root ? relative(root, arg) : "";
    arg = root && !rel.startsWith("..") && !isAbsolute(rel) ? rel || "." : arg.replace(homedir(), "~");
  }
  // the folder itself inside a command (ls -la /the/folder/src) is shown as ./
  if (root && key !== undefined && arg.includes(root)) arg = arg.replaceAll(root + "/", "").replaceAll(root, ".");
  arg = arg.replace(/\s+/g, " ");
  const label = `${name}(${arg.length > 80 ? arg.slice(0, 79) + "…" : arg})`;
  if (step.phase === "start") return { name, label };
  if (step.refused) return { name, label, summary: "refused" };
  // agy tells what it read, not the text: "17 lines, 373 bytes"
  const read = name === "Read" && step.ok !== false && /^(\d+) lines?, \d+ bytes$/.exec(step.output?.trim() ?? "");
  if (read) return { name, label, summary: `Read ${read[1]} line${read[1] === "1" ? "" : "s"}` };
  const lines = step.output?.trimEnd() ? step.output.trimEnd().split("\n").length : 0;
  const count = `${lines} line${lines === 1 ? "" : "s"}`;
  const summary = step.ok === false ? `failed${step.exit !== undefined ? ` · exit ${step.exit}` : ""} · ${count}` : step.exit !== undefined ? `exit ${step.exit} · ${count}` : lines ? count : "done";
  return { name, label, summary };
}

/** Runs another agent harness non-interactively (here or on another machine, over ssh) and streams its answer back. */
export class HarnessProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly config: HarnessProviderConfig,
  ) {}

  get model(): string {
    return this.config.model;
  }

  get executable(): string | null {
    return Bun.which(this.config.ssh ? this.config.ssh[0]! : this.config.command);
  }

  /** Where it runs: its own cwd if the config says, else the person's folder (as an agent), else a neutral folder. */
  private where(workspace?: string): string {
    const cwd = this.config.cwd;
    if (cwd === undefined && workspace) return workspace;
    if (cwd === ".") return process.cwd();
    const dir = cwd ? cwd.replace(/^~(?=\/|$)/, homedir()) : join(KLI_DIR, "harness");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * How it runs this time: as an agent in the person's folder, in plan mode there (only reading), or isolated (no
   * folder, as for a test; on another machine, where the folder is not). In plan mode, a CLI that has no plan mode
   * of its own (Kimi in prompt mode, one with its own arguments) runs isolated, away from the folder.
   */
  how(workspace?: ChatRequest["workspace"]): { mode: "agent" | "plan" | "isolated"; args: string[]; root?: string } {
    const modes = this.config.modes;
    if (!workspace || this.config.ssh) return { mode: "isolated", args: modes?.isolated ?? [] };
    if (workspace.mode === "plan") return modes?.plan.length ? { mode: "plan", args: modes.plan, root: workspace.root } : { mode: "isolated", args: modes?.isolated ?? [] };
    return { mode: "agent", args: modes?.agent ?? [], root: workspace.root };
  }

  async chat({ messages, signal, onDelta, workspace, onAgentTool }: ChatRequest): Promise<ChatResponse> {
    const executable = this.executable;
    if (!executable) throw new ProviderError(this.name, `command not found: ${this.config.ssh ? this.config.ssh[0] : this.config.command}`);
    const prompt = harnessPrompt(messages);
    const template = this.config.args ?? [];
    const viaArg = template.some((a) => a.includes("{prompt}"));
    const run = this.how(workspace);
    const args = harnessArgs(template, prompt, this.config.model, run.args);
    // on another machine: a login shell (for its PATH) in a neutral folder there
    const argv = this.config.ssh
      ? [executable, ...this.config.ssh.slice(1), `bash -lc ${shellQuote(`mkdir -p ~/.kli/harness && cd ~/.kli/harness && exec ${[this.config.command, ...args].map(shellQuote).join(" ")}`)}`]
      : [executable, ...args];
    // no clock stops a CLI: it works until it ends, or until the person stops it (Esc)

    const cwd = this.config.ssh ? undefined : this.where(run.root);
    const proc = Bun.spawn(argv, {
      cwd,
      // some CLIs (OpenCode) take the folder from $PWD, which still says where the terminal was
      env: { ...process.env, ...(cwd && { PWD: cwd }), ...this.config.env },
      stdin: viaArg ? "ignore" : Buffer.from(prompt),
      stdout: "pipe",
      stderr: "pipe",
      // a group of its own: stopping it stops what it started too (its tools' commands), which would otherwise hold
      // its output open, and the answer would wait for them long after the person stopped it
      detached: true,
    });
    const group = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        proc.kill(signal); // the group is gone already
      }
    };
    const kill = () => {
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), 2000).unref();
    };
    signal?.addEventListener("abort", kill);
    if (signal?.aborted) kill();
    const stderr = new Response(proc.stderr).text();

    let text = "";
    let held = ""; // trailing line breaks wait until more text comes, so the answer never ends in blank lines
    let result: Result | undefined;
    const emit = (delta: string) => {
      const body = delta.replace(/\n+$/, "");
      const tail = delta.slice(body.length);
      if (body) {
        text += held + body;
        onDelta?.(held + body);
        held = "";
      }
      held += tail;
    };
    const reader = this.config.format && this.config.format !== "text" ? READERS[this.config.format] : undefined;
    const started = new Map<string, ToolStep>();
    // where the text stood at each of its tool steps: what it says after the last one is its last message
    const cuts: number[] = [];
    try {
      const decoder = new TextDecoder();
      let rest = "";
      for await (const chunk of proc.stdout) {
        const piece = decoder.decode(chunk, { stream: true });
        if (!reader) {
          emit(piece);
          continue;
        }
        rest += piece;
        let end: number;
        while ((end = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, end).trim();
          rest = rest.slice(end + 1);
          if (!line.startsWith("{")) continue;
          let reading: Reading | undefined;
          try {
            reading = reader(JSON.parse(line));
          } catch {
            continue; // a line that is not JSON (a log, a warning) is not part of the answer
          }
          if (reading?.delta) emit(reading.delta);
          if (reading?.result) result = reading.result;
          for (const step of reading?.tools ?? []) {
            if (cuts.at(-1) !== text.length) cuts.push(text.length);
            // an end may come with only the id: name and input from its start
            const begun = started.get(step.id);
            const full = { ...begun, ...step, name: step.name ?? begun?.name, input: step.input ?? begun?.input };
            if (step.phase === "start") started.set(step.id, full);
            const shown = agentTool(full, run.root);
            onAgentTool?.({ phase: step.phase, id: step.id, name: shown.name, label: shown.label, ...(step.phase === "end" && { ok: full.ok ?? true, summary: shown.summary, output: full.output, ...(full.refused && { refused: true }) }) });
          }
        }
      }
      if (!reader) emit(decoder.decode());
    } finally {
      signal?.removeEventListener("abort", kill);
    }
    const code = await proc.exited;
    if (signal?.aborted) throw new ProviderError(this.name, "interrupted", text.length > 0);
    if (result?.error) throw new ProviderError(this.name, result.error, text.length > 0);
    if (code !== 0) {
      const said = await stderr;
      // 255: ssh itself failed, before the CLI there ran
      const detail = this.config.ssh && code === 255 ? sshWhy(this.config.ssh, said) : said.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300);
      throw new ProviderError(this.name, `${this.config.command} exited with code ${code}${detail ? `: ${detail}` : ""}`, text.length > 0);
    }
    if (!text && result?.text) emit(result.text); // no partial messages: the whole answer arrives at the end
    const final = lastMessage(text, cuts);
    return { text, inputTokens: result?.inputTokens, outputTokens: result?.outputTokens, costUsd: result?.costUsd, ...(result?.thinkingTokens && { thinkingTokens: result.thinkingTokens }), ...(final && { final }) };
  }
}
