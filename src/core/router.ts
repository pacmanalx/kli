import { connection, resolveRef, type Target } from "./locations.ts";
import { createProvider, type ProviderFactory } from "./providers/index.ts";
import type { ChatRequest, ChatResponse, Provider, ToolSpec } from "./providers/provider.ts";
import type { TraceEvent, TraceSink } from "./trace.ts";
import { Tunnels } from "./tunnels.ts";
import { ConfigError, ProviderError, type Config, type Message } from "./types.ts";

export interface RoutedResponse extends ChatResponse {
  /** Who answered: "mac/ollama", or the location of an API. */
  provider: string;
  model: string;
  /** The full name of the model that answered. */
  ref: string;
  ms: number;
  /** Set when a fallback is the one that answered: every model that failed before it, in order. */
  fallback?: { from: string; reason: string; failed: { provider: string; reason: string }[] };
}

export interface ChatOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** Every event that goes to the trace, as it happens (the live status of a surface). */
  onEvent?: (event: TraceEvent) => void;
  /** Use this model ("location/provider/model") instead of the config's. */
  model?: string;
  /** Tried after the model instead of the config's fallback (a stack's node has its own, often none). */
  fallback?: string[];
  /** This call's temperature instead of the config's (the triage wants the same answer every time). */
  temperature?: number;
  /** A cap on this answer's tokens (the triage reads one word; a CLI has no such cap). */
  maxTokens?: number;
  /** The tools the model may ask for. */
  tools?: ToolSpec[];
  /** Where the person works and in which mode (a CLI agent works there). */
  workspace?: ChatRequest["workspace"];
  /** A tool a CLI agent used. */
  onAgentTool?: ChatRequest["onAgentTool"];
}

/**
 * Every model call goes through here: it finds the model's location and provider in the config, opens what it
 * needs (a tunnel) and falls back along the config's fallback list when the model fails before answering.
 */
export class Router {
  private readonly providers = new Map<string, { url?: string; provider: Provider }>();
  readonly tunnels = new Tunnels();

  constructor(
    private config: Config,
    private readonly create: ProviderFactory = createProvider,
  ) {}

  /** Starts using an edited config: providers are created again on their next use. */
  reconfigure(config: Config): void {
    this.config = config;
    this.providers.clear();
  }

  target(ref: string): Target {
    return resolveRef(this.config, ref);
  }

  /** The model a session starts on: the config's, or else the first location's default. */
  defaultModel(): string {
    if (this.config.model) return this.target(this.config.model).ref;
    for (const name of Object.keys(this.config.locations))
      try {
        return this.target(name).ref;
      } catch {}
    throw new ConfigError('no model to use: set "model" in the config, or choose one with /model');
  }

  /** What a prompt tries, in order: the chosen model, then the fallback list. */
  order(chosen?: string, fallback = this.config.fallback ?? []): Target[] {
    const refs = [chosen ?? this.defaultModel(), ...fallback];
    const seen = new Set<string>();
    return refs.map((r) => this.target(r)).filter((t) => !seen.has(t.ref) && !!seen.add(t.ref));
  }

  /** The target's provider, made once; one behind a tunnel is made again when the tunnel opened again on another port. */
  async connect(target: Target): Promise<Provider> {
    const config = await connection(this.config, target, this.tunnels);
    const url = "url" in config ? config.url : undefined;
    let known = this.providers.get(target.ref);
    if (!known || known.url !== url) this.providers.set(target.ref, (known = { url, provider: this.create(target.label, config) }));
    return known.provider;
  }

  async chat(messages: Message[], options: ChatOptions, trace: TraceSink): Promise<RoutedResponse> {
    const { onEvent, model: chosen, fallback, ...request } = options;
    const record = (event: TraceEvent) => {
      trace.record(event);
      onEvent?.(event);
    };
    const order = this.order(chosen, fallback);
    let previous: { ref: string; error: ProviderError } | undefined;
    const failed: { provider: string; reason: string }[] = [];

    for (const [i, target] of order.entries()) {
      const { label, model, ref } = target;
      if (previous) record({ type: "fallback", from: previous.ref, to: ref, reason: previous.error.message });
      record({ type: "request", provider: label, model, messages: messages.length });
      const started = performance.now();
      try {
        const p = await this.connect(target).catch((e: Error) => {
          throw new ProviderError(label, e.message);
        });
        const r = await p.chat({ messages, ...request, temperature: request.temperature ?? this.config.temperature });
        const ms = Math.round(performance.now() - started);
        record({
          type: "response",
          provider: label,
          model,
          ms,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          ...(r.costUsd !== undefined && { costUsd: r.costUsd }),
          content: r.text,
        });
        return { ...r, provider: label, model, ref, ms, ...(previous && { fallback: { from: previous.ref, reason: previous.error.message, failed } }) };
      } catch (e) {
        const error = e instanceof ProviderError ? e : new ProviderError(label, e instanceof Error ? e.message : String(e));
        const ms = Math.round(performance.now() - started);
        if (options.signal?.aborted) {
          record({ type: "interrupted", provider: label, model, ms, afterText: error.afterText });
          throw error;
        }
        record({ type: "failure", provider: label, model, ms, error: error.message, afterText: error.afterText });
        // Fall back only if nothing reached the user yet; otherwise the answer would come out twice.
        if (error.afterText || i === order.length - 1) throw error;
        failed.push({ provider: ref, reason: error.message });
        previous = { ref, error };
      }
    }
    throw new Error("unreachable: the order is never empty");
  }
}
