import { basename } from "node:path";
import { envFileShown, secret } from "../secrets.ts";
import { shellQuote } from "../tunnels.ts";
import type { ProviderConfig, VertexProviderConfig } from "../types.ts";
import { GoogleAuth } from "./google-auth.ts";
import { getJson } from "./http.ts";

/** A model a provider offers: the id goes in the config's "model"; the detail is for people. */
export interface ModelInfo {
  id: string;
  detail?: string;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const params = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${Math.round(n / 1e6)}M`);

/**
 * The models a provider offers, to choose from (`/model`, `kli models`): an OpenAI-compatible server's /models (with
 * Ollama's sizes and quantization when it is Ollama), Google's Gemini models and the partners' ones served as an API,
 * Anthropic's /v1/models, or what a CLI lists (`agy models`, `opencode models`; Claude Code has aliases only).
 */
export async function listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  switch (config.type) {
    case "openai":
      return openaiModels(config.url, config.apiKeyEnv, signal);
    case "vertex":
      return vertexModels(config, signal);
    case "anthropic": {
      const env = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
      const key = secret(env);
      if (!key) throw new Error(`missing API key: put ${env} in ${envFileShown()}`);
      const json = await getJson(`${(config.url ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/models?limit=100`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, 20_000, signal);
      return (json.data ?? []).map((m: { id: string; display_name?: string }) => ({ id: m.id, detail: m.display_name }));
    }
    case "harness":
      return harnessModels(config.command, config.ssh, signal);
  }
}

async function openaiModels(url: string, apiKeyEnv: string | undefined, signal?: AbortSignal): Promise<ModelInfo[]> {
  const base = url.replace(/\/+$/, "");
  const key = apiKeyEnv ? secret(apiKeyEnv) : undefined;
  if (apiKeyEnv && !key) throw new Error(`missing API key: put ${apiKeyEnv} in ${envFileShown()}`);
  const json = await getJson(`${base}/models`, key ? { Authorization: `Bearer ${key}` } : {}, 10_000, signal);
  const data: { id: string; owned_by?: string; meta?: { n_params?: number; size?: number; ftype?: string } }[] = json.data ?? [];
  // an exo cluster lists its whole catalog: only what it has loaded answers
  if (data.some((m) => m.owned_by === "exo")) {
    const loaded = await exoLoaded(new URL(base).origin, signal);
    if (loaded) return loaded;
  }
  // Ollama tells more about each model on /api/tags
  const ollama = new Map<string, string>();
  try {
    const tags = await getJson(`${new URL(base).origin}/api/tags`, {}, 5_000, signal);
    for (const m of tags.models ?? [])
      if (m.details) ollama.set(m.name, [m.details.parameter_size, m.details.quantization_level, m.size ? gb(m.size) : ""].filter(Boolean).join(" · "));
  } catch {}
  return data.map((m) => {
    const meta = m.meta;
    const llamacpp = meta ? [meta.n_params ? params(meta.n_params) : "", meta.ftype ?? "", meta.size ? gb(meta.size) : ""].filter(Boolean).join(" · ") : "";
    return { id: m.id, detail: ollama.get(m.id) || llamacpp || m.owned_by };
  });
}

/**
 * The models an exo cluster has loaded (its /state), with the machines each one runs on; undefined when the state
 * cannot be read, so the catalog is shown as it came.
 */
async function exoLoaded(origin: string, signal?: AbortSignal): Promise<ModelInfo[] | undefined> {
  let state: { instances?: Record<string, Record<string, ExoInstance>>; nodeIdentities?: Record<string, { friendlyName?: string; hostname?: string }> };
  try {
    state = await getJson(`${origin}/state`, {}, 10_000, signal);
  } catch {
    return undefined;
  }
  const name = (id: string) => state.nodeIdentities?.[id]?.friendlyName ?? state.nodeIdentities?.[id]?.hostname ?? id.slice(0, 8);
  // the same model can be loaded more than once: one line, with every machine it is on
  const models = new Map<string, { nodes: Set<string>; card?: ExoCard }>();
  for (const instance of Object.values(state.instances ?? {})) {
    const assignments = Object.values(instance)[0]?.shardAssignments;
    if (!assignments?.modelId) continue;
    const m = models.get(assignments.modelId) ?? { nodes: new Set<string>() };
    for (const node of Object.keys(assignments.nodeToRunner ?? {})) m.nodes.add(name(node));
    m.card ??= Object.values(Object.values(assignments.runnerToShard ?? {})[0] ?? {})[0]?.modelCard;
    models.set(assignments.modelId, m);
  }
  return [...models].map(([id, m]) => ({
    id,
    detail: [`loaded on ${[...m.nodes].join(" + ")}`, m.card?.quantization ?? "", m.card?.storageSize?.inBytes ? gb(m.card.storageSize.inBytes) : ""].filter(Boolean).join(" · "),
  }));
}

type ExoCard = { quantization?: string; storageSize?: { inBytes?: number } };
type ExoInstance = { shardAssignments?: { modelId?: string; nodeToRunner?: Record<string, string>; runnerToShard?: Record<string, Record<string, { modelCard?: ExoCard }>> } };

/** Claude Code takes an alias for the latest model of a family, or a full model name. */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: "sonnet", detail: "alias · latest Sonnet" },
  { id: "opus", detail: "alias · latest Opus" },
  { id: "haiku", detail: "alias · latest Haiku" },
  { id: "fable", detail: "alias · latest Fable" },
];

async function harnessModels(command: string, ssh?: string[], signal?: AbortSignal, retried = false): Promise<ModelInfo[]> {
  const name = basename(command);
  if (name === "claude") return CLAUDE_MODELS;
  if (name !== "agy" && name !== "opencode") throw new Error(`${name} has no model list: type the model, or leave it empty for its default`);
  const executable = Bun.which(ssh ? ssh[0]! : command);
  if (!executable) throw new Error(`command not found: ${ssh ? ssh[0] : command}`);
  const argv = ssh ? [executable, ...ssh.slice(1), `bash -lc ${shellQuote(`${shellQuote(command)} models`)}`] : [executable, "models"];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stop = AbortSignal.timeout(30_000);
  const kill = () => proc.kill();
  stop.addEventListener("abort", kill);
  signal?.addEventListener("abort", kill);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  stop.removeEventListener("abort", kill);
  signal?.removeEventListener("abort", kill);
  if (code !== 0) throw new Error(`${name} models exited with code ${code}`);
  // agy: "id<TAB>label"; opencode: "provider/model"
  const models = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^fetching/i.test(line))
    .map((line) => {
      const [id, detail] = line.split("\t");
      return { id: id!.trim(), detail: detail?.trim() };
    });
  // opencode sometimes lists nothing while it refreshes its own cache: once more
  if (!models.length && !retried && !signal?.aborted) {
    await Bun.sleep(500);
    return harnessModels(command, ssh, signal, true);
  }
  return models;
}

/** Google's partners whose models Vertex serves as an API (the "-maas" ones). */
const PARTNERS = ["deepseek-ai", "zai-org", "openai", "qwen", "moonshotai", "meta", "minimaxai", "mistralai"];

async function vertexModels(config: VertexProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const region = config.location ?? "global";
  const host = (r: string) => (config.url ?? (r === "global" ? "https://aiplatform.googleapis.com" : `https://${r}-aiplatform.googleapis.com`)).replace(/\/+$/, "");
  const key = config.apiKeyEnv ? secret(config.apiKeyEnv) : undefined;
  const headers = key ? { "x-goog-api-key": key } : await new GoogleAuth(config.credentials).headers();
  const stage = (s?: string) => s?.toLowerCase().replace("_", " ");
  const json = await getJson(`${host(region)}/v1beta1/publishers/google/models?pageSize=300`, headers, 20_000, signal);
  // chat models only: no embeddings, speech, image or live variants
  const skip = /embedding|tts|transcribe|live|image|translate|robotics|computer-use|nano-banana/;
  const gemini: ModelInfo[] = (json.publisherModels ?? [])
    .map((m: { name: string; launchStage?: string }) => ({ id: m.name.split("/").at(-1)!, stage: stage(m.launchStage) }))
    .filter((m: { id: string }) => m.id.startsWith("gemini") && !skip.test(m.id))
    .map((m: { id: string; stage?: string }) => ({ id: `google/${m.id}`, detail: m.stage }))
    // generally available first, newest first
    .sort((a: ModelInfo, b: ModelInfo) => Number(a.detail !== "ga") - Number(b.detail !== "ga") || b.id.localeCompare(a.id, undefined, { numeric: true }));
  // the partners are only listed by the regional hosts
  const partners = await Promise.all(
    PARTNERS.map((publisher) =>
      getJson(`${host(region === "global" ? "us-central1" : region)}/v1beta1/publishers/${publisher}/models?pageSize=300`, headers, 20_000, signal)
        .then((j) =>
          (j.publisherModels ?? [])
            .map((m: { name: string; launchStage?: string }) => ({ id: m.name.split("/").at(-1)!, stage: stage(m.launchStage) }))
            .filter((m: { id: string }) => m.id.endsWith("-maas"))
            .map((m: { id: string; stage?: string }) => ({ id: `${publisher}/${m.id}`, detail: m.stage })),
        )
        .catch(() => [] as ModelInfo[]),
    ),
  );
  return [...gemini, ...partners.flat()];
}
