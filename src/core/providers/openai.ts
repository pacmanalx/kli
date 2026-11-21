import { secret } from "../secrets.ts";
import { ProviderError, type Message, type OpenAIProviderConfig, type ToolCall } from "../types.ts";
import { streamSse } from "./http.ts";
import type { ChatRequest, ChatResponse, Provider } from "./provider.ts";

type Headers = () => Promise<Record<string, string>>;

/**
 * The conversation in the OpenAI format: an assistant's tool calls, and each tool's answer as a "tool" message. The
 * server's own instructions go at the end of the system message (one is added when there is none).
 */
export function openaiMessages(messages: Message[], instructions?: string): unknown[] {
  if (instructions) {
    const at = messages.findIndex((m) => m.role === "system");
    messages = at < 0 ? [{ role: "system", content: instructions }, ...messages] : messages.map((m, i) => (i === at ? { ...m, content: `${m.content}\n\n${instructions}` } : m));
  }
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length)
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
      };
    return { role: m.role, content: m.content };
  });
}

/** Arguments arrive as a JSON string, sometimes in pieces; one that does not parse goes to the tool as it is. */
export function parseArguments(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : { _invalid: text };
  } catch {
    return { _invalid: text };
  }
}

/** A server that does not take tools says so in a 400 (llama-server without --jinja, models without a tool template). */
const NO_TOOLS = /tool|function|jinja/i;

/**
 * OpenAI-compatible chat API over plain HTTP (no SDK). `auth` replaces the API key when the endpoint needs another
 * scheme (Vertex's OpenAI-compatible endpoint takes a Google token).
 */
export class OpenAIProvider implements Provider {
  /** The server refused tools once: from then on it is asked without them. */
  private noTools = false;

  constructor(
    readonly name: string,
    private readonly config: Omit<OpenAIProviderConfig, "type"> & { type?: "openai" },
    private readonly auth?: Headers,
  ) {}

  get model(): string {
    return this.config.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const offered = request.tools?.length && !this.noTools ? request.tools : undefined;
    try {
      return await this.call(request, offered);
    } catch (e) {
      if (!offered || !(e instanceof ProviderError) || e.status !== 400 || !NO_TOOLS.test(e.message)) throw e;
      this.noTools = true;
      const r = await this.call(request, undefined);
      return { ...r, notice: `${this.name} does not take tools (${e.message.slice(0, 120)}): it answered without them` };
    }
  }

  private async call({ messages, temperature, maxTokens, signal, onDelta }: ChatRequest, tools: ChatRequest["tools"]): Promise<ChatResponse> {
    const apiKey = this.config.apiKeyEnv ? secret(this.config.apiKeyEnv) : undefined;
    const headers = this.auth ? await this.auth() : apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    let text = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
    // tool calls come in pieces, by index: the id and the name first, then the arguments a bit at a time
    const calls = new Map<number, { id?: string; name: string; args: string }>();
    await streamSse({
      provider: this.name,
      url: `${this.config.url.replace(/\/+$/, "")}/chat/completions`,
      headers,
      body: {
        ...this.config.extra,
        model: this.config.model,
        messages: openaiMessages(messages, this.config.instructions),
        stream: true,
        stream_options: { include_usage: true },
        ...(temperature !== undefined && { temperature }),
        ...(maxTokens !== undefined && { max_tokens: maxTokens }),
        ...(tools && { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
      },
      signal,
      hasText: () => text.length > 0,
      onData: (data) => {
        if (data === "[DONE]") return true;
        const chunk = JSON.parse(data);
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === "string" && delta.content) {
          text += delta.content;
          onDelta?.(delta.content);
        }
        for (const [i, piece] of (delta?.tool_calls ?? []).entries()) {
          const index = typeof piece.index === "number" ? piece.index : i;
          const call = calls.get(index) ?? { name: "", args: "" };
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name += piece.function.name;
          if (piece.function?.arguments)
            call.args += typeof piece.function.arguments === "string" ? piece.function.arguments : JSON.stringify(piece.function.arguments);
          calls.set(index, call);
        }
      },
    });
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([index, c]) => ({ id: c.id ?? `call_${index}`, name: c.name, input: parseArguments(c.args) }));
    const thinking = usage?.completion_tokens_details?.reasoning_tokens;
    return { text, inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, ...(thinking && { thinkingTokens: thinking }), ...(toolCalls.length && { toolCalls }) };
  }
}
