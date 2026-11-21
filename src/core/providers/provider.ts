import type { Message, ToolCall } from "../types.ts";

/** A tool offered to the model: its name, what it does, and its input as a JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: Message[];
  /** Tools the model may ask for; the answer then may carry tool calls instead of (or after) text. */
  tools?: ToolSpec[];
  temperature?: number;
  /** A cap on this answer's tokens, over the config's (the triage wants one word: a small model goes on talking). */
  maxTokens?: number;
  /** Interruption requested by the user (Ctrl+C). */
  signal?: AbortSignal;
  /** Called for every piece of text as it arrives. */
  onDelta?: (text: string) => void;
  /** The folder the person works in and the permission mode: a CLI agent works there, with its own tools. */
  workspace?: { root: string; mode: "default" | "acceptEdits" | "plan" };
  /** A tool a CLI agent used, as it happened. */
  onAgentTool?: (event: AgentToolEvent) => void;
}

/** A tool used inside a CLI agent (Claude Code, Antigravity…): Kli shows it; the CLI ran it. */
export interface AgentToolEvent {
  phase: "start" | "end";
  id: string;
  name: string;
  /** Bash(ls -la), Write(oi.txt). */
  label: string;
  ok?: boolean;
  /** The CLI's own rules did not let it run: no one gave the permission. */
  refused?: boolean;
  summary?: string;
  output?: string;
}

export interface ChatResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  /** How many of the output tokens were thinking, not text (when the provider says). */
  thinkingTokens?: number;
  /** What the call cost, when the provider says (harnesses such as Claude Code do). */
  costUsd?: number;
  /** The tools the model asked for, in order. */
  toolCalls?: ToolCall[];
  /** The model's turn as the provider needs it back (see Message.raw). */
  raw?: Message["raw"];
  /** Something the person should know about this answer (e.g. the server took no tools). */
  notice?: string;
  /**
   * A CLI agent's last message: the text after its last tool step, when it said something before (what it would do,
   * what it found). The text has all of it, for the screen; the next steps of a stack get only this.
   */
  final?: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
