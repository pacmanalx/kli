import type { Router } from "./router.ts";
import type { TraceSink } from "./trace.ts";
import type { Message } from "./types.ts";

/**
 * The triage before a stack (docs/kli.md, "Triagem"): a small, fast model reads the person's new message, with the
 * last exchange, and says whether it asks for the work the stack is for (its `purpose`). When it does not (a question
 * outside that work, thanks, a quick command such as a push), one model answers it, as when no stack is chosen.
 * What it cannot decide goes to the stack: a wrong "stack" costs time; a wrong "one" would cost the comparison.
 */

export type Route = "one" | "stack";

/** The last thing said: the person's message and the answer they got. */
export interface Exchange {
  prompt: string;
  answer: string;
}

export interface TriageResult {
  route: Route;
  /** The triage model, as the config names it. */
  model: string;
  ms: number;
  /** What the triage model said the message asks for. */
  why?: string;
  /** Why the triage did not decide (it failed, or its answer could not be read): the stack runs. */
  error?: string;
}

/** How much of the last exchange the triage reads: what was proposed is usually at the end of the answer. */
const BEFORE_PROMPT = 400;
const BEFORE_ANSWER = 1200;
/** The triage's answer is one word; a model that talks on is cut here (a CLI is not: it has no such cap). */
const ANSWER_TOKENS = 32;
/** How much of an answer the other side of the conversation hears (the stack's nodes, or the model). */
const HEARD_ANSWER = 3000;

/**
 * What the triage model reads: the rules for a stack whose work is `purpose`, examples for another purpose, a few
 * turns that show the answer (small models follow turns better than rules), then the last exchange and the message.
 * Measured on 03/11/2026, on 78 labeled messages: qwen2.5-7b got 74 of 78 messages right with this, against 61 with a
 * plain yes/no question; Gemini 3.5 Flash Lite, 76.
 */
export function triageMessages(purpose: string, message: string, before?: Exchange): Message[] {
  const work = purpose.trim();
  const system = [
    "You are the triage of Kli, a terminal harness that runs models. You decide who handles the person's new message: the stack or one model.",
    "",
    `The stack is for: ${work}`,
    "The stack is slow and costly (several models work on the same request), so it gets only the messages that ask for that work.",
    "",
    'Answer "stack" when the message asks for the kind of work the stack is for, whether it asks with a question or an order, in many words or in a few: a short "go ahead", "do option 2" or "next slice" asks for the work of the plan or options the conversation just proposed.',
    'Answer "one" when it asks for something else: a question outside that work, small talk, thanks, a question about what was just done, or one quick command or action (list, read or show something; git status, commit, push or merge; run the tests or the linter; install; create a branch).',
    "",
    'Examples, for a stack that is for "writing and editing marketing copy":',
    "- New message: write three slogans for the new perfume → stack",
    "- New message: what is a slogan? → one",
    "- New message: thanks! → one",
    "- Before: Kli proposed two directions for the campaign. New message: the second one → stack",
    "- New message: save it to slogans.txt → one",
    "",
    "Reply with one word: stack or one.",
  ].join("\n");
  // the turns: the "stack" one asks, in the purpose's own words, for its work
  const shots: [string, Route][] = [
    ["New message: thanks, that was great", "one"],
    ["New message: git push", "one"],
    [`New message: ${work.split(":")[0]!.replace(/[.\s]+$/, "")}, please`, "stack"],
    ["New message: what time is it in Tokyo?", "one"],
    ["Before: Kli proposed a plan in three steps for that work.\nNew message: go ahead", "stack"],
    ["New message: run the tests", "one"],
  ];
  return [
    { role: "system", content: system },
    ...shots.flatMap(([user, answer]): Message[] => [
      { role: "user", content: user },
      { role: "assistant", content: answer },
    ]),
    { role: "user", content: triageInput(message, before) },
  ];
}

/** The triage's last turn: the last exchange, cut, and the new message. */
export function triageInput(message: string, before?: Exchange): string {
  if (!before) return `New message: ${message}`;
  const prompt = before.prompt.length > BEFORE_PROMPT ? before.prompt.slice(0, BEFORE_PROMPT) + "…" : before.prompt;
  const answer = before.answer.length > BEFORE_ANSWER ? "…" + before.answer.slice(-BEFORE_ANSWER) : before.answer;
  return `Before: the person said "${prompt}", and Kli answered: ${answer}\nNew message: ${message}`;
}

/**
 * The route in the triage's answer. Its first word, when it is "stack" or "one": that is what was asked, and a small
 * model may go on talking after it (lfm3 wrote "one", then "Wait, let me parse this…" for 2,000 tokens). Else its last
 * line, when it is just the word, with what came before as why; else the last of the two words in it.
 */
export function readTriage(text: string): { route: Route; why?: string } | undefined {
  const word = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const isRoute = (w: string): w is Route => w === "stack" || w === "one";
  const first = word(text.trim().split(/\s+/)[0] ?? "");
  if (isRoute(first)) return { route: first };
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = word(lines.at(-1) ?? "");
  const why = lines.length > 1 ? lines.slice(0, -1).join(" ").slice(0, 200) : undefined;
  if (isRoute(last)) return { route: last, ...(why && { why }) };
  const words = [...text.toLowerCase().matchAll(/\b(stack|one)\b/g)].map((m) => m[1]!);
  const route = words.at(-1);
  return route && isRoute(route) ? { route } : undefined;
}

/**
 * Asks `model` (no tools, temperature 0, no fallback: another model in its place would decide differently) whether
 * `message` asks for the stack's work. A failure or an answer that cannot be read sends the message to the stack;
 * only the person stopping it (Esc) throws.
 */
export async function triage(router: Router, model: string, purpose: string, message: string, before: Exchange | undefined, trace: TraceSink, signal?: AbortSignal): Promise<TriageResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const r = await router.chat(triageMessages(purpose, message, before), { model, fallback: [], temperature: 0, maxTokens: ANSWER_TOKENS, signal }, trace);
    // a provider that did not hear the stop in time: the person stopped it all the same
    signal?.throwIfAborted();
    const read = readTriage(r.text);
    if (!read) return { route: "stack", model, ms: ms(), error: `could not read its answer: ${r.text.trim().slice(0, 80) || "(empty)"}` };
    return { route: read.route, model, ms: ms(), ...(read.why && { why: read.why }) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { route: "stack", model, ms: ms(), error: (e as Error).message };
  }
}

/** What one side of the conversation tells the other: `who` answered the person, and what. */
export function heardNote(exchange: Exchange, who = "one model alone (the triage saw it was not the stack's work)"): string {
  const answer = exchange.answer.length > HEARD_ANSWER ? exchange.answer.slice(0, HEARD_ANSWER) + "…" : exchange.answer;
  return `Meanwhile, ${who} answered the person.\nThe person: ${exchange.prompt}\nThe answer: ${answer}`;
}
