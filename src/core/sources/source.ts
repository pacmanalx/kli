/**
 * A data source a grounding node searches. Every type has the same shape: it gets a query and gives back excerpts,
 * each with where it came from (to cite it), its text, how relevant it is and when it changed. The grounding node
 * never knows where an excerpt came from beyond that.
 */
export interface Excerpt {
  /** The source's name in the config. */
  source: string;
  /** What it is: a file name, a section. */
  title: string;
  /** Where it is, to cite it: "docs/guia.md:12-30". */
  ref: string;
  /** A link to open it: file:///…, https://… */
  link?: string;
  text: string;
  /** How well it matches the query, to sort by (each source its own scale). */
  score: number;
  /** The share of the query's words it has, 0 to 1: what the person sees. */
  relevance: number;
  /** When it changed (ISO date). */
  modified?: string;
}

export interface Source {
  readonly name: string;
  /** The `top` excerpts that best match the query, best first. */
  search(query: string, top: number, signal?: AbortSignal): Promise<Excerpt[]>;
}

/** Words that say little about what is searched, in Portuguese and English. */
const STOP = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas por para pra com sem sob sobre e ou que se não nao mais menos muito como quando onde qual quais quem é ser foi são sao está esta estão tem têm ter há ao aos à às isso isto esse essa este esta aquele aquela seu sua seus suas meu minha nosso nossa lhe já ja também tambem só so mas pelo pela pelos pelas até ate entre depois antes " +
    "the a an of to in on at by for with without and or not is are was were be been being it its this that these those as from into about than then there their they them we you your our i me my he she his her what which who whom when where why how do does did done have has had can could should would will just also only any some all each more most such no yes"
  ).split(" "),
);

/** The words of a text, as searched: lower case, without accents, no stop words or single letters. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** BM25 over pieces of text: each piece's score for the query, and the share of the query's words it has. */
export function rank(query: string, pieces: string[]): { score: number; relevance: number }[] {
  const terms = [...new Set(words(query))];
  const docs = pieces.map((p) => {
    const counts = new Map<string, number>();
    const ws = words(p);
    for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
    return { counts, length: ws.length };
  });
  const avg = docs.reduce((t, d) => t + d.length, 0) / Math.max(1, docs.length) || 1;
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.counts.has(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return docs.map((d) => {
    let score = 0;
    let found = 0;
    for (const t of terms) {
      const f = d.counts.get(t) ?? 0;
      if (!f) continue;
      found++;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return { score, relevance: terms.length ? found / terms.length : 0 };
  });
}
