import { listSessions, readTrace, type StoredEvent } from "./trace.ts";

export interface ProviderStats {
  provider: string;
  model: string;
  answers: number;
  failures: number;
  medianMs: number;
  p90Ms: number;
  inputTokens: number;
  outputTokens: number;
  /** Only what the providers reported (harnesses do; APIs do not). */
  costUsd: number;
}

/** What the traces say about a period (or about some sessions): counts, outcomes, latency and tokens. */
export interface Stats {
  sessions: number;
  prompts: number;
  /** How each prompt ended. */
  outcomes: { answered: number; failed: number; interrupted: number };
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  medianMs?: number;
  /** Fastest median first. */
  providers: ProviderStats[];
  /** One entry per local day, oldest first, zero-filled. Empty when filtering by session. */
  days: { date: string; answers: number }[];
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

export const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function collectStats(dir: string, options: { days?: number; sessions?: string[]; now?: Date } = {}): Stats {
  const now = options.now ?? new Date();
  const days = options.days ?? 30;
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const ids = options.sessions ?? listSessions(dir, Infinity);

  const stats: Stats = { sessions: 0, prompts: 0, outcomes: { answered: 0, failed: 0, interrupted: 0 }, fallbacks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, providers: [], days: [] };
  // one row per provider and model: "mac/ollama" answers with several
  const byProvider = new Map<string, { name: string; model: string; ms: number[]; failures: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  const perDay = new Map<string, number>();
  const requested = new Map<string, string>();
  const all: number[] = [];
  const provider = (name: string, model = "") => {
    const key = `${name}\u0000${model}`;
    let p = byProvider.get(key);
    if (!p) byProvider.set(key, (p = { name, model, ms: [], failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }));
    return p;
  };

  for (const id of ids) {
    const events = readTrace(dir, id).filter((e) => options.sessions || new Date(e.ts) >= since);
    if (!events.some((e) => e.type === "prompt")) continue;
    stats.sessions++;
    // a prompt ends answered, interrupted, or failed (every provider it reached failed)
    let open: "pending" | undefined;
    const close = () => {
      if (open) stats.outcomes.failed++;
      open = undefined;
    };
    for (const e of events as StoredEvent[]) {
      // a stack's nodes run side by side: their prompts and answers measure the models, not how the prompt ended
      const inNode = e.node !== undefined;
      switch (e.type) {
        case "prompt":
          if (inNode) break;
          close();
          stats.prompts++;
          open = "pending";
          break;
        case "stack":
          if (e.phase !== "end") break;
          open = undefined;
          if (e.interrupted) stats.outcomes.interrupted++;
          else if (e.ok) {
            stats.outcomes.answered++;
            const day = localDate(new Date(e.ts));
            perDay.set(day, (perDay.get(day) ?? 0) + 1);
          } else stats.outcomes.failed++;
          break;
        case "response": {
          // a prompt that used tools has a response per step: it was answered once
          if (!inNode && open) {
            open = undefined;
            stats.outcomes.answered++;
            const day = localDate(new Date(e.ts));
            perDay.set(day, (perDay.get(day) ?? 0) + 1);
          }
          requested.set(e.provider, e.model);
          const p = provider(e.provider, e.model);
          p.ms.push(e.ms);
          all.push(e.ms);
          p.inputTokens += e.inputTokens ?? 0;
          p.outputTokens += e.outputTokens ?? 0;
          stats.inputTokens += e.inputTokens ?? 0;
          stats.outputTokens += e.outputTokens ?? 0;
          p.costUsd += e.costUsd ?? 0;
          stats.costUsd += e.costUsd ?? 0;
          break;
        }
        case "request":
          requested.set(e.provider, e.model);
          break;
        case "interrupted":
          if (inNode) break;
          open = undefined;
          stats.outcomes.interrupted++;
          break;
        case "failure":
          // older traces leave the model out of a failure: the one last asked of that provider
          provider(e.provider, e.model ?? requested.get(e.provider)).failures++;
          break;
        case "fallback":
          stats.fallbacks++;
          break;
      }
    }
    close();
  }

  stats.providers = [...byProvider.values()]
    .filter((p) => p.ms.length || p.failures)
    .map((p) => {
      const sorted = [...p.ms].sort((a, b) => a - b);
      return { provider: p.name, model: p.model, answers: p.ms.length, failures: p.failures, medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9), inputTokens: p.inputTokens, outputTokens: p.outputTokens, costUsd: p.costUsd };
    })
    .sort((a, b) => (a.answers ? a.medianMs : Infinity) - (b.answers ? b.medianMs : Infinity));
  if (all.length) stats.medianMs = percentile(all.sort((a, b) => a - b), 0.5);
  if (!options.sessions)
    for (let i = 0; i < days; i++) {
      const date = localDate(new Date(since.getFullYear(), since.getMonth(), since.getDate() + i));
      stats.days.push({ date, answers: perDay.get(date) ?? 0 });
    }
  return stats;
}
