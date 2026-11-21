import { discover } from "./discover.ts";
import { CLI_PRESETS, SERVER_PORTS } from "./presets.ts";
import { listModels } from "./providers/models.ts";
import { secret } from "./secrets.ts";
import type { Config, LocationConfig, MachineProvider, StackConfig, StackNode } from "./types.ts";

/** What `kli init` found on this machine: the servers with their chat models, the CLIs, the API keys already set. */
export interface Found {
  /** Servers on their usual ports, with the chat models they serve (first = the default). */
  servers: { name: string; port: number; models: string[] }[];
  /** CLIs on the PATH that Kli knows ("claude", "agy"…), in the order of CLI_PRESETS. */
  clis: string[];
  /** The API keys set in the environment or in ~/.kli/.env, by the variable's name. */
  keys: string[];
}

/** The APIs `kli init` adds when their key is set. Only Anthropic gets a default model: the others are chosen in /model. */
export const STARTER_APIS: { env: string; name: string; location: LocationConfig }[] = [
  { env: "ANTHROPIC_API_KEY", name: "anthropic", location: { type: "anthropic", model: "claude-sonnet-5-5" } },
  { env: "GEMINI_API_KEY", name: "gemini", location: { type: "api", url: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY" } },
  { env: "OPENROUTER_API_KEY", name: "openrouter", location: { type: "api", url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" } },
  { env: "OPENAI_API_KEY", name: "openai", location: { type: "api", url: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" } },
];

/** The name of this machine in the config: models are "local/ollama/qwen3:4b", "local/claude/sonnet". */
export const HERE = "local";

/** Claude Code takes aliases: the stronger answers and judges; the smaller one is a second voice when nothing else is. */
const CLI_MODELS: Record<string, string[]> = { claude: ["sonnet", "haiku"] };

/** Models a server lists that do not chat (embeddings, rerankers, speech). */
const NOT_CHAT = /embed|bge-|nomic|rerank|whisper|tts|minilm|e5-/i;

export const INSTRUCTIONS =
  "You are Kli, an assistant that runs in the terminal. Be direct and concise. Always reply in the language the user writes in. If you don't know something, say so.";

/** Looks at this machine: the servers on their usual ports and their models, the CLIs on the PATH, the keys. */
export async function lookAround(): Promise<Found> {
  const providers = await discover({ type: "machine", providers: {} });
  const servers = await Promise.all(
    SERVER_PORTS.filter((s) => providers[s.name]?.type === "server").map(async (s) => {
      const models = await listModels({ type: "openai", url: `http://localhost:${s.port}/v1`, model: "" }).catch(() => []);
      return { name: s.name, port: s.port, models: models.map((m) => m.id).filter((id) => !NOT_CHAT.test(id)) };
    }),
  );
  const clis = Object.keys(CLI_PRESETS).filter((c) => providers[c]?.type === "cli");
  const keys = STARTER_APIS.map((a) => a.env).filter((env) => !!secret(env));
  return { servers, clis, keys };
}

/** A model the stacks can use, strongest first: the CLIs, then an API, then the local servers. */
interface Candidate {
  ref: string;
  /** Who serves it ("claude", "ollama", "anthropic"): two answers from the same one compare less. */
  by: string;
  cli: boolean;
}

function candidates(found: Found): Candidate[] {
  const first: Candidate[] = [];
  const second: Candidate[] = [];
  for (const c of found.clis) {
    const [model, smaller] = CLI_MODELS[c] ?? [];
    first.push({ ref: model ? `${HERE}/${c}/${model}` : `${HERE}/${c}`, by: c, cli: true });
    if (smaller) second.push({ ref: `${HERE}/${c}/${smaller}`, by: c, cli: true });
  }
  for (const api of STARTER_APIS) {
    const model = "model" in api.location ? api.location.model : undefined;
    if (model && found.keys.includes(api.env)) first.push({ ref: `${api.name}/${model}`, by: api.name, cli: false });
  }
  for (const s of found.servers) for (const m of s.models.slice(0, 2)) first.push({ ref: `${HERE}/${s.name}/${m}`, by: s.name, cli: false });
  return [...first, ...second];
}

/** A node's name from its model: "local/ollama/qwen3:4b" → "qwen3-4b", "local/agy" → "agy"; never one already taken. */
function nodeName(ref: string, taken: Set<string>): string {
  const base =
    ref
      .split("/")
      .slice(-1)[0]!
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "") || "model";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/**
 * The stacks to start with, from the models found: `compare`, `review` and `choose` with two of them (from two
 * different servers or CLIs when there are), and `agents` when two CLIs can change the code side by side. The
 * strongest model joins, chooses and judges.
 */
export function starterStacks(found: Found): Record<string, StackConfig> {
  const all = candidates(found);
  const strong = all[0];
  const other = all.find((c) => c.by !== strong?.by) ?? all[1];
  if (!strong || !other) return {};
  const taken = new Set(["join", "judge", "choice"]);
  const [a, b] = [nodeName(strong.ref, taken), nodeName(other.ref, taken)];
  const answer = (model: string, extra: Partial<StackNode> = {}): StackNode => ({ model, ...extra });
  const stacks: Record<string, StackConfig> = {
    compare: {
      description: "the same prompt to two models, their answers side by side",
      nodes: { [a]: answer(strong.ref), [b]: answer(other.ref) },
    },
    review: {
      description: "two models answer, the strongest joins them into one answer, and a verifier judges it against the request",
      nodes: {
        [a]: answer(strong.ref),
        [b]: answer(other.ref),
        join: { model: strong.ref, role: "aggregate", from: [a, b] },
        judge: { model: strong.ref, role: "verify", from: ["join", a, b] },
      },
    },
    choose: {
      description: "two models answer; you choose one on the full screen, or a model chooses when no one can (kli -p)",
      nodes: {
        [a]: answer(strong.ref, { tools: "none" }),
        [b]: answer(other.ref, { tools: "none" }),
        choice: { model: strong.ref, role: "choose", from: [a, b], by: ["person", "model"] },
      },
    },
  };
  const agents = all.filter((c) => c.cli);
  const second = agents.find((c) => c.by !== agents[0]?.by);
  if (agents[0] && second) {
    const taken = new Set(["judge"]);
    const [x, y] = [nodeName(agents[0].ref, taken), nodeName(second.ref, taken)];
    stacks.agents = {
      description: "two agents change the code, each in its own copy of the folder; a judge compares them and you apply the one you choose",
      nodes: {
        [x]: answer(agents[0].ref, { tools: "write" }),
        [y]: answer(second.ref, { tools: "write" }),
        judge: { model: strong.ref, role: "verify", from: [x, y] },
      },
    };
  }
  return stacks;
}

/** The config `kli init` writes: this machine with what it has, the APIs with a key, the starter stacks. */
export function starterConfig(found: Found): Config {
  const providers: Record<string, MachineProvider> = {};
  for (const c of found.clis) {
    const model = CLI_MODELS[c]?.[0];
    providers[c] = { type: "cli", command: c, ...(model && { model }) };
  }
  for (const s of found.servers) providers[s.name] = { type: "server", port: s.port, ...(s.models[0] && { model: s.models[0] }) };
  const locations: Record<string, LocationConfig> = {};
  if (Object.keys(providers).length) locations[HERE] = { type: "machine", providers };
  for (const api of STARTER_APIS) if (found.keys.includes(api.env)) locations[api.name] = api.location;
  const model = candidates(found)[0]?.ref;
  const stacks = starterStacks(found);
  return {
    ...(model && { model }),
    instructions: INSTRUCTIONS,
    locations,
    ...(Object.keys(stacks).length && { stacks }),
  };
}
