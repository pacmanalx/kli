import { envFileShown, secretSource } from "../secrets.ts";
import type { ProviderConfig } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GoogleAuth } from "./google-auth.ts";
import { HarnessProvider } from "./harness.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./provider.ts";
import { VertexProvider } from "./vertex.ts";

export type ProviderFactory = (name: string, config: ProviderConfig) => Provider;

export const createProvider: ProviderFactory = (name, config) => {
  switch (config.type) {
    case "openai":
      return new OpenAIProvider(name, config);
    case "vertex":
      return new VertexProvider(name, config);
    case "anthropic":
      return new AnthropicProvider(name, config);
    case "harness":
      return new HarnessProvider(name, config);
  }
};

export interface ProviderInfo {
  type: string;
  model: string;
  /** Where the calls go: a URL, or project · location. */
  endpoint: string;
  /** Which credentials will be used, checked locally (no network). */
  auth: string;
  ready: boolean;
}

export function describeProvider(config: ProviderConfig): ProviderInfo {
  const env = (name: string) => {
    const from = secretSource(name);
    return { auth: from ? `${name} ${from === "file" ? `in ${envFileShown()}` : "set"}` : `needs ${name} in ${envFileShown()}`, ready: !!from };
  };
  switch (config.type) {
    case "openai":
      return { type: "openai", model: config.model, endpoint: config.url, ...(config.apiKeyEnv ? env(config.apiKeyEnv) : { auth: "no key", ready: true }) };
    case "vertex": {
      if (config.apiKeyEnv && secretSource(config.apiKeyEnv)) return { type: "vertex", model: config.model, endpoint: `${config.project} · ${config.location ?? "global"}`, ...env(config.apiKeyEnv) };
      const auth = new GoogleAuth(config.credentials).describe();
      return { type: "vertex", model: config.model, endpoint: `${config.project} · ${config.location ?? "global"}`, auth, ready: !auth.startsWith("no ") && !auth.startsWith("unsupported") };
    }
    case "anthropic":
      return { type: "anthropic", model: config.model, endpoint: config.url ?? "https://api.anthropic.com", ...env(config.apiKeyEnv ?? "ANTHROPIC_API_KEY") };
    case "harness": {
      if (config.ssh) return { type: "harness", model: config.model, endpoint: `${config.command} on ${config.ssh.at(-1)}`, auth: `${config.command}'s login there`, ready: true };
      const path = Bun.which(config.command);
      return { type: "harness", model: config.model, endpoint: path ?? `${config.command} (not on PATH)`, auth: path ? `${config.command}'s own login` : "not installed", ready: !!path };
    }
  }
}

export type { ChatRequest, ChatResponse, Provider } from "./provider.ts";
