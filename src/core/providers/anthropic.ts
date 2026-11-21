import { envFileShown, secret } from "../secrets.ts";
import { ProviderError, type AnthropicProviderConfig, type Message, type ToolCall } from "../types.ts";
import { streamSse } from "./http.ts";
import { parseArguments } from "./openai.ts";
import type { ChatRequest, ChatResponse, Provider } from "./provider.ts";

/**
 * The conversation in Anthropic's format: an assistant's tool calls are tool_use blocks, and the tools' answers go
 * back together in the next user message as tool_result blocks.
 */
export function anthropicMessages(messages: Message[]): unknown[] {
  const out: { role: string; content: string | ({ type: string } & Record<string, unknown>)[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    // plain text stays plain; a turn with tool calls is a list of blocks
    if (!m.toolCalls?.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    out.push({ role: m.role, content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))] });
  }
  return out;
}

/** Anthropic's Messages API over plain HTTP, streaming. */
export class AnthropicProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly config: AnthropicProviderConfig,
  ) {}

  get model(): string {
    return this.config.model;
  }

  get keyEnv(): string {
    return this.config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  }

  async chat({ messages, tools, temperature, maxTokens, signal, onDelta }: ChatRequest): Promise<ChatResponse> {
    const key = secret(this.keyEnv);
    if (!key) throw new ProviderError(this.name, `missing API key: put ${this.keyEnv} in ${envFileShown()}`);
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const toolCalls: ToolCall[] = [];
    let open: { id: string; name: string; json: string } | undefined;
    await streamSse({
      provider: this.name,
      url: `${(this.config.url ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        ...this.config.extra,
        model: this.config.model,
        max_tokens: maxTokens ?? this.config.maxTokens ?? 4096,
        ...(system && { system }),
        messages: anthropicMessages(messages),
        stream: true,
        ...(temperature !== undefined && { temperature }),
        ...(tools?.length && { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }),
      },
      signal,
      hasText: () => text.length > 0,
      onData: (data) => {
        const event = JSON.parse(data);
        switch (event.type) {
          case "message_start":
            inputTokens = event.message?.usage?.input_tokens;
            break;
          case "content_block_start":
            if (event.content_block?.type === "tool_use") open = { id: event.content_block.id, name: event.content_block.name, json: "" };
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) {
              text += event.delta.text;
              onDelta?.(event.delta.text);
            } else if (event.delta?.type === "input_json_delta" && open) open.json += event.delta.partial_json ?? "";
            break;
          case "content_block_stop":
            if (open) toolCalls.push({ id: open.id, name: open.name, input: parseArguments(open.json) });
            open = undefined;
            break;
          case "message_delta":
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            break;
          case "message_stop":
            return true;
          case "error":
            throw new ProviderError(this.name, event.error?.message ?? "stream error", text.length > 0);
        }
      },
    });
    return { text, inputTokens, outputTokens, ...(toolCalls.length && { toolCalls }) };
  }
}
