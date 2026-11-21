import { secret } from "../secrets.ts";
import { ProviderError, type Message, type ToolCall, type VertexProviderConfig } from "../types.ts";
import { GoogleAuth } from "./google-auth.ts";
import { streamSse } from "./http.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ChatRequest, ChatResponse, Provider } from "./provider.ts";

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};

/**
 * The conversation in Gemini's format. A model turn that came from Gemini goes back exactly as it came (its thought
 * signatures are required with function calls); the tools' answers go together in one user turn.
 */
export function geminiContents(messages: Message[]): { role: string; parts: GeminiPart[] }[] {
  const out: { role: string; parts: GeminiPart[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const part: GeminiPart = { functionResponse: { name: m.toolName ?? "tool", response: { content: m.content } } };
      const last = out.at(-1);
      if (last?.role === "user" && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
      continue;
    }
    if (m.role === "assistant") {
      const parts = m.raw?.provider === "gemini" ? (m.raw.parts as GeminiPart[]) : [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.input } }))];
      out.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    out.push({ role: "user", parts: [{ text: m.content }] });
  }
  return out;
}
type GeminiChunk = {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

/**
 * Vertex AI, picking the endpoint by the model's publisher: google/* → native Gemini API (streamGenerateContent);
 * anything else → Vertex's OpenAI-compatible endpoint. Auth: an API key when the location has one, else gcloud's login.
 */
export class VertexProvider implements Provider {
  readonly auth: GoogleAuth;
  private readonly compatible?: OpenAIProvider;

  constructor(
    readonly name: string,
    private readonly config: VertexProviderConfig,
    auth?: GoogleAuth,
  ) {
    this.auth = auth ?? new GoogleAuth(config.credentials);
    if (this.publisher !== "google")
      this.compatible = new OpenAIProvider(
        name,
        { url: `${this.root}/endpoints/openapi`, model: config.model, extra: config.extra },
        () => this.headers(),
      );
  }

  get model(): string {
    return this.config.model;
  }

  private get publisher(): string {
    return this.config.model.includes("/") ? this.config.model.split("/", 1)[0]! : "google";
  }

  private get root(): string {
    const location = this.config.location ?? "global";
    const host = this.config.url ?? (location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`);
    return `${host.replace(/\/+$/, "")}/v1/projects/${this.config.project}/locations/${location}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const key = this.config.apiKeyEnv ? secret(this.config.apiKeyEnv) : undefined;
    if (key) return { "x-goog-api-key": key };
    try {
      return await this.auth.headers();
    } catch (e) {
      throw new ProviderError(this.name, (e as Error).message);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.compatible) return this.compatible.chat(request);
    const { messages, tools, temperature, maxTokens, signal, onDelta } = request;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const { generationConfig, ...extra } = (this.config.extra ?? {}) as { generationConfig?: Record<string, unknown> };
    const model = this.config.model.replace(/^google\//, "");
    let text = "";
    let usage: GeminiChunk["usageMetadata"];
    const kept: GeminiPart[] = []; // the model turn, to send back as it came
    const toolCalls: ToolCall[] = [];
    await streamSse({
      provider: this.name,
      url: `${this.root}/publishers/google/models/${model}:streamGenerateContent?alt=sse`,
      headers: await this.headers(),
      body: {
        ...extra,
        contents: geminiContents(messages),
        ...(system && { systemInstruction: { parts: [{ text: system }] } }),
        ...(tools?.length && { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }),
        generationConfig: {
          ...generationConfig,
          ...(temperature !== undefined && { temperature }),
          ...((maxTokens ?? this.config.maxTokens) && { maxOutputTokens: maxTokens ?? this.config.maxTokens }),
        },
      },
      signal,
      hasText: () => text.length > 0,
      onData: (data) => {
        const chunk = JSON.parse(data) as GeminiChunk;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.thought) continue; // thinking stays out of the answer
          if (part.functionCall) {
            kept.push(part);
            toolCalls.push({ id: part.functionCall.id ?? `gemini_${toolCalls.length}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
            continue;
          }
          if (part.text === undefined) continue;
          kept.push(part);
          text += part.text;
          if (part.text) onDelta?.(part.text);
        }
      },
    });
    const output = usage?.candidatesTokenCount !== undefined ? usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0) : undefined;
    return {
      text,
      inputTokens: usage?.promptTokenCount,
      outputTokens: output,
      ...(usage?.thoughtsTokenCount && { thinkingTokens: usage.thoughtsTokenCount }),
      ...(toolCalls.length && { toolCalls, raw: { provider: "gemini", parts: kept } }),
    };
  }
}
