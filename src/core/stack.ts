import { CHOOSERS, GROUND_MODES, GROUND_QUERIES, MASKS, NODE_ROLES, type GroundMode, type StackConfig, type StackNode } from "./types.ts";

/**
 * A model stack: a graph of models that answers as one. The prompt goes to the nodes without inputs, which run at
 * the same time; a node with `from` waits for those and gets their answers. The nodes nobody gets from (or the ones
 * marked `output`) are what the stack answers, so a stack can give two answers side by side, to compare them.
 */

/** What is wrong with a stack's shape; the models are checked when it runs, so a removed one does not break the config. */
export function stackProblems(name: string, stack: StackConfig): string[] {
  const where = `stack "${name}"`;
  const nodes = stack?.nodes && typeof stack.nodes === "object" ? Object.entries(stack.nodes) : [];
  if (!nodes.length) return [`${where}: it has no nodes`];
  const problems: string[] = [];
  if (stack.purpose !== undefined && (typeof stack.purpose !== "string" || !stack.purpose.trim())) problems.push(`${where}: "purpose" is the work the stack is for, in words`);
  for (const [id, n] of nodes) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) problems.push(`${where}: node "${id}": use letters, digits, dot, dash or underscore`);
    if (n?.role === "ground") problems.push(...groundProblems(`${where}: node "${id}"`, n));
    else if (!n || typeof n.model !== "string" || !n.model) problems.push(`${where}: node "${id}": missing "model"`);
    for (const key of GROUND_KEYS) if (n?.[key] !== undefined && n.role !== "ground") problems.push(`${where}: node "${id}": "${key}" is for a grounding node (role "ground")`);
    for (const f of n?.from ?? []) if (!stack.nodes[f]) problems.push(`${where}: node "${id}" gets from "${f}", which is not a node`);
    if (n?.tools !== undefined && n.tools !== "read" && n.tools !== "none" && n.tools !== "write") problems.push(`${where}: node "${id}": tools is "read", "write" or "none"`);
    if (n?.tools === "write" && (n.role ?? "answer") !== "answer") problems.push(`${where}: node "${id}": only a node that answers writes (to ${n.role}, its tools read or are none)`);
    if (n?.role !== undefined && !NODE_ROLES.includes(n.role)) problems.push(`${where}: node "${id}": role is ${NODE_ROLES.join(", ")}`);
    if ((n?.role === "aggregate" || n?.role === "verify" || n?.role === "choose") && !n.from?.length) problems.push(`${where}: node "${id}": to ${n.role}, it needs "from" (the answers it gets)`);
    if (n?.by !== undefined && (!Array.isArray(n.by) || !n.by.length || n.by.some((b) => !CHOOSERS.includes(b))))
      problems.push(`${where}: node "${id}": by is a list of ${CHOOSERS.join(", ")}, in the order to try`);
    if (n?.by !== undefined && n.role !== "choose") problems.push(`${where}: node "${id}": "by" is for a node that chooses (role "choose")`);
    if (n?.min !== undefined && (!Number.isInteger(n.min) || n.min < 1 || n.min > (n.from?.length ?? 0)))
      problems.push(`${where}: node "${id}": min is between 1 and the number of nodes it gets from`);
    if (n?.requirements !== undefined && (!Array.isArray(n.requirements) || n.requirements.some((r) => typeof r !== "string" || !r.trim())))
      problems.push(`${where}: node "${id}": requirements is a list of texts, such as ["cites the file it changed"]`);
    if (n?.requirements !== undefined && n.role !== "verify") problems.push(`${where}: node "${id}": "requirements" is for a node that verifies (role "verify")`);
  }
  problems.push(...writeProblems(where, stack.write));
  if (problems.length) return problems;
  if (!nodes.some(([, n]) => !n.from?.length)) problems.push(`${where}: no node gets the prompt (every node has "from")`);
  for (const [id, n] of nodes)
    if (n.role === "ground" && !nodes.some(([, m]) => m.from?.includes(id))) problems.push(`${where}: node "${id}": a grounding node feeds the next step: put it in the "from" of the node that uses its context`);
  try {
    stackOrder(stack);
  } catch (e) {
    problems.push(`${where}: ${(e as Error).message}`);
  }
  return problems;
}

/** What a node is set to, for the screen: its model, or the sources a grounding node searches. */
export const nodeModel = (node: StackNode) => node.model ?? `grounding · ${(node.sources ?? []).join(", ")}`;

/** The fields only a grounding node has. */
const GROUND_KEYS = ["sources", "mode", "query", "rules", "attach", "budget", "top", "mask"] as const;

/** What is wrong with a grounding node: it has no model, and it searches the sources it names. */
function groundProblems(where: string, n: StackNode): string[] {
  const problems: string[] = [];
  if (n.model !== undefined) problems.push(`${where}: a grounding node has no model: it only searches (leave "model" out)`);
  if (!Array.isArray(n.sources) || !n.sources.length || n.sources.some((s) => typeof s !== "string" || !s)) problems.push(`${where}: to ground, it needs "sources": the names of the config's data sources`);
  if (n.mode !== undefined && !GROUND_MODES.includes(n.mode)) problems.push(`${where}: mode is ${GROUND_MODES.join(" or ")}`);
  if (n.query !== undefined && !GROUND_QUERIES.includes(n.query)) problems.push(`${where}: query is ${GROUND_QUERIES.join(", ")}`);
  if ((n.query === "answers" || n.query === "both") && !n.from?.length) problems.push(`${where}: to search with the answers, it needs "from" (the nodes whose answers it gets)`);
  if (n.rules !== undefined && typeof n.rules !== "string") problems.push(`${where}: rules is a text`);
  if (n.attach !== undefined && (!Array.isArray(n.attach) || n.attach.some((p) => typeof p !== "string" || !/^[~/]/.test(p)))) problems.push(`${where}: attach is a list of files, each from / or ~`);
  if (n.budget !== undefined && (!Number.isInteger(n.budget) || n.budget < 100 || n.budget > 200_000)) problems.push(`${where}: budget is a number of tokens, from 100 to 200000`);
  if (n.top !== undefined && (!Number.isInteger(n.top) || n.top < 1 || n.top > 100)) problems.push(`${where}: top is a number from 1 to 100`);
  if (n.mask !== undefined && (!Array.isArray(n.mask) || n.mask.some((m) => !MASKS.includes(m)))) problems.push(`${where}: mask is a list of ${MASKS.join(", ")}`);
  if (n.tools !== undefined) problems.push(`${where}: a grounding node has no tools`);
  if (n.output) problems.push(`${where}: a grounding node is never an answer of the stack`);
  return problems;
}

/** A command of words: letters, digits and the signs a path or a flag uses. */
const PLAIN_COMMAND = /^[\w@%+=:,.\/-]+( [\w@%+=:,.\/-]+)*$/;

/** What is wrong with the settings of the nodes that write: commands are text, and each one in `run` is one command. */
export function writeProblems(where: string, write: StackConfig["write"]): string[] {
  if (write === undefined) return [];
  if (!write || typeof write !== "object" || Array.isArray(write)) return [`${where}: "write" is an object: { run, check, fence }`];
  const problems: string[] = [];
  // an old setup is left alone: nothing is set up any more
  if (write.check !== undefined && (typeof write.check !== "string" || !write.check.trim())) problems.push(`${where}: write.check is a command line`);
  if (write.run !== undefined && !Array.isArray(write.run)) problems.push(`${where}: write.run is a list of commands, such as ["bun test"]`);
  // words only: this file is also the builder page's, so it does not parse the shell
  for (const command of Array.isArray(write.run) ? write.run : [])
    if (typeof command !== "string" || !PLAIN_COMMAND.test(command.trim()))
      problems.push(`${where}: write.run: ${JSON.stringify(command)} is not one plain command (words only: no &&, ;, |, $, quotes or redirections)`);
  const fence = write.fence;
  if (fence !== undefined && fence !== false) {
    if (!fence || typeof fence !== "object" || Array.isArray(fence)) problems.push(`${where}: write.fence is false (off) or { "network": true, "write": ["~/folder"] }`);
    else {
      if (fence.network !== undefined && typeof fence.network !== "boolean") problems.push(`${where}: write.fence.network is true or false`);
      if (fence.write !== undefined && (!Array.isArray(fence.write) || fence.write.some((p) => typeof p !== "string" || !/^[~/]/.test(p))))
        problems.push(`${where}: write.fence.write is a list of folders, each from / or ~`);
    }
  }
  return problems;
}

/**
 * Whether the stack's nodes that write work in the person's folder itself: copies are for comparing, so with only one
 * node that writes it edits the folder, as in a conversation (Alexandre, 02/11/2026).
 */
export const writesInFolder = (stack: StackConfig) => Object.values(stack.nodes).filter((n) => n.tools === "write").length === 1;

/** The nodes in an order where each comes after the ones it gets from (in the config's order otherwise). */
export function stackOrder(stack: StackConfig): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new Error(`it goes round in a circle: ${[...path.slice(path.indexOf(id)), id].join(" → ")}`);
    state.set(id, "visiting");
    for (const f of stack.nodes[id]!.from ?? []) visit(f, [...path, id]);
    state.set(id, "done");
    order.push(id);
  };
  for (const id of Object.keys(stack.nodes)) visit(id, []);
  return order;
}

/**
 * The nodes whose answers the stack gives: the ones marked `output`, or else the ones no node gets from. A node that
 * verifies only judges, and one that grounds only brings context: neither is an answer, and an answer that goes
 * through a grounding node is used by whoever gets from that node (a judge does not count).
 */
export function stackOutputs(stack: StackConfig): string[] {
  const order = stackOrder(stack).filter((id) => stack.nodes[id]!.role !== "verify" && stack.nodes[id]!.role !== "ground");
  const marked = order.filter((id) => stack.nodes[id]!.output);
  if (marked.length) return marked;
  const usedBy = (id: string, seen: Set<string>): boolean =>
    Object.entries(stack.nodes).some(([cid, c]) => c.from?.includes(id) && (c.role === "ground" ? !seen.has(cid) && usedBy(cid, seen.add(cid)) : c.role !== "verify"));
  return order.filter((id) => !usedBy(id, new Set()));
}

/**
 * The context a grounding node hands on, as the next steps read it: numbered excerpts, each with where it came from,
 * and the rules of its mode. It passes through: the next step also gets the answers that reached the grounding node.
 */
export interface Grounding {
  mode: GroundMode;
  /** The person's rules, over the mode's. */
  rules?: string;
  /** Why the data sources could not be searched (every one failed): the steps after it still run, and are told. */
  unreachable?: string;
  items: { source: string; title: string; ref: string; link?: string; modified?: string; relevance?: number; text: string }[];
}

const MODE_RULES: Record<GroundMode, string> = {
  enrich: "Use the context when it helps, together with what you know, and cite [n] for what comes from it.",
  restrict: "Answer only from the context, citing [n] for each fact you take from it. If what is asked is not in the context, say that it is not there.",
};

/** The context, numbered across every grounding node on the way, and how each kind of step uses it. */
function contextLines(groundings: Grounding[], role: "answer" | "aggregate" | "verify" | "choose"): string[] {
  if (!groundings.length) return [];
  const items = groundings.flatMap((g) => g.items);
  const body = items.length
    ? items.map((it, i) => `[${i + 1}] ${[it.source, it.title, it.ref !== it.title ? it.ref : "", it.modified ? `changed ${it.modified}` : "", it.link ?? ""].filter(Boolean).join(" · ")}\n${it.text.trim()}`).join("\n\n")
    : groundings.some((g) => g.unreachable)
      ? `(the data sources could not be searched: ${groundings.filter((g) => g.unreachable).map((g) => g.unreachable).join("; ")})`
      : "(nothing was found in the data sources for this request)";
  // the strictest mode on the way wins: restrict over enrich
  const mode: GroundMode = groundings.some((g) => g.mode === "restrict") ? "restrict" : "enrich";
  const rules = [MODE_RULES[mode], ...groundings.flatMap((g) => (g.rules ? [g.rules] : []))];
  const use =
    role === "verify"
      ? ["The answers were given this context from data sources. Judge too whether what they say agrees with it and cites it as asked:", rules.map((r) => `- ${r}`).join("\n")]
      : role === "choose"
        ? ["The answers were given this context from data sources: prefer the one that agrees with it and cites it as asked."]
        : [`<rules>\n${rules.join("\n")}\n</rules>`];
  return ["Context from data sources:", "", `<context>\n${body}\n</context>`, "", ...use, ""];
}

/** An answer a node gets: its letter and its text, which carries the changes when the step that wrote it changed files. */
export interface Answer {
  label: string;
  text: string;
  /** The step changed files in its copy: its text carries the diff and the check (`withChanges`). */
  changed?: boolean;
  /** The tools the step used, in order (Bash(ls), Read(x.py) (failed)): a judge or a chooser gets them listed. */
  tools?: string[];
  /** How much the step changed, when it may change files: a judge or a chooser gets every answer's side by side. */
  size?: { files: number; added: number; removed: number };
  /** Why the step did not end (it failed after changing files): a judge still judges what it left, said to be unfinished. */
  unfinished?: string;
}

/** The most tools of one answer a judge or a chooser gets listed. */
const MAX_TOOLS = 30;

/**
 * An answer as a judge or a chooser reads it: its text, then the tools its step used. Its words alone did not say
 * them: a judge marked "used a tool" missing in two answers that had used one, once a CLI's narration stopped going
 * on (06/11/2026); the steps of Kli's own loop never went on.
 */
const judgedBody = (a: Answer) => {
  const tools = a.tools ?? [];
  if (!tools.length) return a.text.trim();
  const shown = tools.slice(0, MAX_TOOLS).join(", ") + (tools.length > MAX_TOOLS ? `, … and ${tools.length - MAX_TOOLS} more` : "");
  return `${a.text.trim()}\n<tools used="${tools.length}">${shown}</tools>`;
};

const toolsNote = (answers: Answer[]) =>
  answers.some((a) => a.tools?.length) ? ["In <tools>, after an answer's words: the tools its step used to answer (what it read, searched or ran), in order.", ""] : [];

/** An answer in the prompt of a judge or a chooser, with its letter, and said to be unfinished when its step failed. */
const answerBlock = (a: Answer) => `<answer id="${a.label}"${a.unfinished ? ` unfinished="${a.unfinished.replaceAll('"', "'")}"` : ""}>\n${judgedBody(a)}\n</answer>\n`;

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

/**
 * The size of each answer's changes, side by side, when two or more may change files. Read one by one, inside each
 * diff, the sizes gave a judge no measure: it marked "the smallest change" met for a diff twice the size of another
 * (02/11/2026). In a later round, `sized` carries the answers judged before too.
 */
function sizesLines(sized: Answer[]): string[] {
  const with_ = sized.filter((a) => a.size).sort((a, b) => a.label.localeCompare(b.label));
  if (with_.length < 2) return [];
  return [
    "The size of each answer's changes, side by side:",
    ...with_.map(({ label, size }) => `- ${label}: ${size!.files ? `${size!.files} file${size!.files === 1 ? "" : "s"}, ${lines(size!.added)} added, ${size!.removed} removed (${lines(size!.added + size!.removed)} in all)` : "no file changed"}`),
    "When the request asks for the smallest change, or only what is needed, weigh these sizes: of the changes that do what is asked, the smaller one meets it; one that does the same with clearly more does not fully meet it.",
    "",
  ];
}

/** What a judge is told when some answers did not end. */
const unfinishedNote = (answers: Answer[]) =>
  answers.some((a) => a.unfinished)
    ? ['An answer marked unfinished did not end: its step failed after it had changed files. Judge what it left as it is (its words so far, its changes, its check): a requirement it did not get to is missing.', ""]
    : [];

/** The longest diff a node that joins, judges or chooses gets of one answer (the middle is cut). */
const MAX_PATCH = 30_000;

/** A long text without its middle. */
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max / 2)}\n… (${text.length - max} characters left out) …\n${text.slice(-max / 2)}`);

/** An answer that changed files, as the next steps see it: the text, the diff, and how the check ended. */
export function withChanges(
  text: string,
  changes: { files: unknown[]; added: number; removed: number; patch: string },
  check?: { command: string; ok: boolean; code: number | null; output: string },
): string {
  const parts = [text.trim(), "", `<changes files="${changes.files.length}" added="${changes.added}" removed="${changes.removed}">`, cut(changes.patch.trimEnd(), MAX_PATCH) || "(no file changed)", "</changes>"];
  if (check) parts.push(`<check command="${check.command}" passed="${check.ok ? "yes" : "no"}" exit="${check.code ?? "stopped"}">`, check.output.trim() || "(it printed nothing)", "</check>");
  return parts.join("\n");
}

/** What the steps that get answers are told when some of them changed files. */
const changesNote = (answers: Answer[]) =>
  answers.some((a) => a.changed)
    ? ["Some answers changed files of the project: the diff of what each changed comes in <changes>, and, when the project has a check (its tests), how it ended in <check>. Weigh the changes as part of the answer, not only its words.", ""]
    : [];

/** An answer in the prompt of a node that joins or aggregates; one that did not end says so. */
const givenBlock = (a: Answer) => `<answer from="${a.label}"${a.unfinished ? ` unfinished="${a.unfinished.replaceAll('"', "'")}"` : ""}>\n${a.text.trim()}\n</answer>\n`;

/**
 * What a node that joins or aggregates is told of the steps that did not answer (12/11/2026: a stack does not stop
 * when one fails, and the next step does what it did not): what one said before it failed comes marked unfinished,
 * and the ones that said nothing are named by letter.
 */
const missingNote = (answers: Answer[], silent: string[]) => [
  ...(answers.some((a) => a.unfinished) ? ["An answer marked unfinished stopped before it ended: use what is right in it, and do yourself what it did not get to.", ""] : []),
  ...(silent.length ? [`${silent.length === 1 ? `Step ${silent[0]}` : `Steps ${silent.join(", ")}`} did not answer: do yourself what ${silent.length === 1 ? "it was" : "they were"} to do.`, ""] : []),
];

/**
 * How a node that joins others sees them: the request, then each answer with a letter, without the model's name;
 * and the context of the grounding nodes on the way. With context and no answers, the request and the context.
 * `silent`: the letters of the steps that gave no answer at all.
 */
export function joinPrompt(request: string, answers: Answer[], groundings: Grounding[] = [], silent: string[] = []): string {
  if (!answers.length) return ["<request>", request, "</request>", "", ...missingNote(answers, silent), ...contextLines(groundings, "answer"), "Answer the request."].join("\n");
  return [
    "<request>",
    request,
    "</request>",
    "",
    "Earlier steps answered this request. Their answers:",
    "",
    ...answers.map(givenBlock),
    ...changesNote(answers),
    ...missingNote(answers, silent),
    ...contextLines(groundings, "answer"),
    "Answer the request, using what is right in these answers. Do not mention the steps or their letters.",
  ].join("\n");
}

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const CONTRIBUTIONS = "contributions";

/** What an aggregator gets: the answers by letter, and how to say how much of its answer came from each. */
export function aggregatePrompt(request: string, answers: Answer[], groundings: Grounding[] = [], silent: string[] = []): string {
  // nothing to aggregate: it answers the request, like a step that joins
  if (!answers.length) return joinPrompt(request, answers, groundings, silent);
  return [
    "<request>",
    request,
    "</request>",
    "",
    "Earlier steps answered this request. Their answers:",
    "",
    ...answers.map(givenBlock),
    ...changesNote(answers),
    ...missingNote(answers, silent),
    ...contextLines(groundings, "aggregate"),
    "Write the best single answer to the request: keep what is right in these answers, leave out what is wrong, and do not mention the steps or their letters.",
    // no example numbers: a model tends to copy them
    `After your answer, on a line of its own, say how much of it came from each answer, as JSON between tags, the shares adding up to 100: <${CONTRIBUTIONS}>{${answers.map((a) => `"${a.label}": …`).join(", ")}}</${CONTRIBUTIONS}>`,
  ].join("\n");
}

/**
 * What a verifier gets: the request and the answers to judge, and the shape of its verdict. `given` are the stack's
 * own requirements: marked first, before the ones it reads in the request, and not listed again. `more`: a later
 * round, with answers that came after the first ones were judged; `given` are then all the requirements of the first
 * round, and it marks those, and only those.
 */
export function verifyPrompt(request: string, answers: Answer[], given: string[] = [], groundings: Grounding[] = [], more = false, sized: Answer[] = answers): string {
  const marks = `{${answers.map((a) => `"${a.label}": {"items": ["met", "partial", "missing"], "note": "one sentence"}`).join(", ")}}`;
  const shape = more ? `{"answers": ${marks}}` : `{"requirements": ["…"], "answers": ${marks}}`;
  const steps = more
    ? [
        `1. More answers to the same request came after the first ones were judged. Judge them on the same requirements, and only these, in this order:\n${given.map((g, i) => `   ${i + 1}. ${g}`).join("\n")}`,
        `2. For each answer, mark each of the ${given.length} requirement${given.length === 1 ? "" : "s"}, in the same order, as "met", "partial" or "missing", and say in one sentence what is missing or wrong.`,
      ]
    : given.length
    ? [
        `1. These requirements are given, and every answer is judged on them too:\n${given.map((g, i) => `   ${i + 1}. ${g}`).join("\n")}`,
        '2. List in "requirements" the requirements of the request itself: everything it asks for, said or clearly meant (the content, and also the format, the length and the language). Do not list the given ones again.',
        `3. For each answer, mark the ${given.length} given requirement${given.length === 1 ? "" : "s"} first and then the request's, in the same order, as "met", "partial" or "missing", and say in one sentence what is missing or wrong.`,
      ]
    : [
        "1. List the requirements of the request: everything it asks for, said or clearly meant (the content, and also the format, the length and the language).",
        '2. For each answer, mark each requirement, in the same order, as "met", "partial" or "missing", and say in one sentence what is missing or wrong.',
      ];
  return [
    "<request>",
    request,
    "</request>",
    "",
    more ? "More answers to judge:" : "Answers to judge:",
    "",
    ...answers.map(answerBlock),
    ...changesNote(answers),
    ...sizesLines(sized),
    ...unfinishedNote(answers),
    ...toolsNote(answers),
    ...contextLines(groundings, "verify"),
    "Judge how well each answer does what the request asks. You only judge: do not answer the request yourself.",
    ...steps,
    "Write the requirements and the notes in the language of the request.",
    `Reply with the JSON only, in this shape: ${shape}`,
  ].join("\n");
}

/**
 * Passes a streamed text through until `<tag>`: what comes from the tag on is for Kli, not for the person, so it is
 * held back, even when the tag arrives split between two pieces.
 */
export class TagCut {
  private held = "";
  private cut = false;
  private readonly open: string;

  constructor(tag: string) {
    this.open = `<${tag}>`;
  }

  push(text: string): string {
    if (this.cut) return "";
    const s = this.held + text;
    const at = s.indexOf(this.open);
    if (at >= 0) {
      this.cut = true;
      this.held = "";
      return s.slice(0, at);
    }
    // a tail that may be the start of the tag waits for the next piece
    let keep = 0;
    for (let k = Math.min(this.open.length - 1, s.length); k > 0; k--)
      if (this.open.startsWith(s.slice(-k))) {
        keep = k;
        break;
      }
    this.held = s.slice(s.length - keep);
    return s.slice(0, s.length - keep);
  }

  /** What was held back when the text ended without the tag. */
  end(): string {
    const rest = this.cut ? "" : this.held;
    this.held = "";
    return rest;
  }
}

export const contributionsCut = () => new TagCut(CONTRIBUTIONS);

/** An aggregator's answer without its contributions block, and the shares by letter (adding up to 100), if it gave them. */
export function readContributions(raw: string): { text: string; shares?: Record<string, number> } {
  const at = raw.indexOf(`<${CONTRIBUTIONS}>`);
  if (at < 0) return { text: raw.trim() };
  const text = raw.slice(0, at).trim();
  const body = raw.slice(at + CONTRIBUTIONS.length + 2).split(`</${CONTRIBUTIONS}>`)[0]!;
  try {
    const parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] >= 0);
    const total = entries.reduce((t, [, v]) => t + v, 0);
    if (!entries.length || total <= 0) return { text };
    return { text, shares: Object.fromEntries(entries.map(([k, v]) => [k, Math.round((v / total) * 100)])) };
  } catch {
    return { text };
  }
}

export type Mark = "met" | "partial" | "missing";

/** A verifier's judgement: the request's requirements, and how each judged answer meets them. */
export interface Verdict {
  requirements: string[];
  judged: { node: string; items: Mark[]; adherence: number; note?: string }[];
}

/** How much an answer adheres to the request, from its marks: met counts 1, partial ½, missing 0. */
export function adherence(items: Mark[]): number {
  if (!items.length) return 0;
  return Math.round((items.reduce((t, m) => t + (m === "met" ? 1 : m === "partial" ? 0.5 : 0), 0) / items.length) * 100);
}

/**
 * The stack's check as one more requirement, marked by Kli from how it ended, not by the verifier: when every answer
 * judged ran it (the aggregator's answer, which changes no file, did not, so then it stays out).
 */
export function withCheck(verdict: Verdict, command: string, passed: Record<string, boolean | undefined>): Verdict {
  if (!verdict.judged.every((j) => passed[j.node] !== undefined)) return verdict;
  return {
    requirements: [...verdict.requirements, `the project's check passes (${command})`],
    judged: verdict.judged.map((j) => {
      const items: Mark[] = [...j.items, passed[j.node] ? "met" : "missing"];
      return { ...j, items, adherence: adherence(items) };
    }),
  };
}

/**
 * Reads a verifier's JSON (it may come with words or a code fence around it); undefined when it is not a verdict.
 * The `given` requirements come first, with the first marks of each answer. `only`: a later round, where `given`
 * are all the requirements, and any other it lists is left out.
 */
export function readVerdict(raw: string, labels: Record<string, string>, given: string[] = [], only = false): Verdict | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: { requirements?: unknown; answers?: Record<string, { items?: unknown; note?: unknown }> };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const read = !only && Array.isArray(parsed.requirements) ? parsed.requirements.filter((r): r is string => typeof r === "string" && !!r.trim()) : [];
  const requirements = [...given, ...read];
  if (!requirements.length || !parsed.answers || typeof parsed.answers !== "object") return undefined;
  const mark = (m: unknown): Mark => (m === "met" || m === "partial" ? m : "missing");
  const judged: Verdict["judged"] = [];
  for (const [label, node] of Object.entries(labels)) {
    const a = parsed.answers[label];
    if (!a || !Array.isArray(a.items)) continue;
    // one mark per requirement: what it left out counts as missing
    const items = requirements.map((_, i) => mark((a.items as unknown[])[i]));
    judged.push({ node, items, adherence: adherence(items), ...(typeof a.note === "string" && a.note.trim() && { note: a.note.trim() }) });
  }
  return judged.length ? { requirements, judged } : undefined;
}

/** What a model that chooses gets: the request and the answers by letter, and the shape of its choice. */
export function choosePrompt(request: string, answers: Answer[], groundings: Grounding[] = []): string {
  return [
    "<request>",
    request,
    "</request>",
    "",
    "Answers to choose from:",
    "",
    ...answers.map(answerBlock),
    ...changesNote(answers),
    ...sizesLines(answers),
    ...toolsNote(answers),
    ...contextLines(groundings, "choose"),
    "Choose the answer that best does what the request asks: its content, and also the format, the length and the language it asks for. You only choose: do not answer the request yourself, and do not prefer an answer for its place in the list. Write why in the language of the request.",
    `Reply with the JSON only, in this shape: {"choice": "${answers[0]?.label ?? "A"}", "why": "one sentence"}`,
  ].join("\n");
}

/** Reads a model's choice (words or a code fence around the JSON are fine); undefined when it chose nothing it was given. */
export function readChoice(raw: string, labels: Record<string, string>): { label: string; node: string; why?: string } | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { choice?: unknown; why?: unknown };
    const label = typeof parsed.choice === "string" ? parsed.choice.trim().toUpperCase() : "";
    const node = labels[label];
    if (!node) return undefined;
    return { label, node, ...(typeof parsed.why === "string" && parsed.why.trim() && { why: parsed.why.trim() }) };
  } catch {
    return undefined;
  }
}
