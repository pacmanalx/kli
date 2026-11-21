import { openSource, type Excerpt, type Source } from "./sources/index.ts";
import { readWhole } from "./sources/files.ts";
import type { Grounding } from "./stack.ts";
import type { Mask, SourceConfig, StackNode } from "./types.ts";

/**
 * What a grounding node does, always the same way: the query → a search in each of its sources, side by side → the
 * rules (the mode's, the person's, what is hidden) → the token budget → the context the next step gets. It has no
 * model: it only searches, sorts and hands over, at no inference cost.
 */

/** Default most tokens of context a grounding node passes on, and most excerpts from each source. */
export const BUDGET = 2000;
export const TOP = 8;

/** About how many tokens a text is: four characters each, as most tokenizers come close to. */
export const tokens = (text: string) => Math.ceil(text.length / 4);

/** What one source gave, measured. */
export interface SourceRun {
  name: string;
  ms: number;
  /** Excerpts it found (up to `top`). */
  found: number;
  /** Of those, how many went on (the budget leaves the least relevant out). */
  kept: number;
  error?: string;
}

/** What a grounding node handed on, and what it took to get it. */
export interface GroundResult extends Grounding {
  query: string;
  sources: SourceRun[];
  /** Tokens of context passed on. */
  tokens: number;
  /** Excerpts the budget left out. */
  cut: number;
}

const MASKED: Record<Mask, [RegExp, string]> = {
  email: [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  cpf: [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]"],
  phone: [/(?<![\w.])\+?\d{0,3}[ (]*\d{2}[) ]*\d{4,5}[ -]?\d{4}\b/g, "[phone]"],
};

/** A text with what the node hides replaced by what it was. */
export function mask(text: string, masks: Mask[] = []): string {
  return masks.reduce((t, m) => t.replace(MASKED[m][0], MASKED[m][1]), text);
}

/** The data sources a stack's grounding nodes use, opened once and kept (a source keeps what it already cut). */
export class Sources {
  private readonly open = new Map<string, Source>();

  constructor(private readonly config: Record<string, SourceConfig> = {}) {}

  get(name: string): Source | undefined {
    const config = this.config[name];
    if (!config) return undefined;
    let s = this.open.get(name);
    if (!s) this.open.set(name, (s = openSource(name, config)));
    return s;
  }
}

/** Runs a grounding node: searches its sources for `query` and keeps the most relevant excerpts that fit its budget. */
export async function ground(node: StackNode, query: string, sources: Sources, signal?: AbortSignal): Promise<GroundResult> {
  const top = node.top ?? TOP;
  const budget = node.budget ?? BUDGET;
  const names = node.sources ?? [];
  const runs: SourceRun[] = [];
  const found: Excerpt[] = [];
  await Promise.all(
    names.map(async (name, i) => {
      const started = performance.now();
      const source = sources.get(name);
      let excerpts: Excerpt[] = [];
      let error: string | undefined;
      if (!source) error = "not one of the config's sources";
      else
        try {
          excerpts = await source.search(query, top, signal);
        } catch (e) {
          error = (e as Error).message;
        }
      runs[i] = { name, ms: Math.round(performance.now() - started), found: excerpts.length, kept: 0, ...(error && { error }) };
      found.push(...excerpts);
    }),
  );
  // the files attached always go first, whole; then the excerpts, the most relevant first, while they fit
  const items: Grounding["items"] = [];
  let used = 0;
  for (const path of node.attach ?? []) {
    const file = readWhole(path);
    if (!file) {
      items.push({ source: "attached", title: path, ref: path, text: "(this file could not be read)" });
      continue;
    }
    const text = mask(file.text, node.mask);
    used += tokens(text);
    items.push({ source: "attached", title: file.ref.split("/").at(-1)!, ref: file.ref, text, modified: file.modified });
  }
  let cut = 0;
  found.sort((a, b) => b.relevance - a.relevance || b.score - a.score);
  for (const e of found) {
    const text = mask(e.text, node.mask);
    const t = tokens(text);
    if (used + t > budget) {
      cut++;
      continue;
    }
    used += t;
    items.push({ source: e.source, title: e.title, ref: e.ref, text, relevance: e.relevance, ...(e.link && { link: e.link }), ...(e.modified && { modified: e.modified }) });
    runs.find((r) => r.name === e.source)!.kept++;
  }
  return { mode: node.mode ?? "enrich", ...(node.rules?.trim() && { rules: node.rules.trim() }), sources: runs, items, query, tokens: used, cut };
}
