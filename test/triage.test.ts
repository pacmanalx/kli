import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLocation, setTriage, validateConfig } from "../src/core/config.ts";
import type { ChatRequest, Provider } from "../src/core/providers/provider.ts";
import { Router } from "../src/core/router.ts";
import { StackRunner } from "../src/core/stack-run.ts";
import { readTrace, Trace } from "../src/core/trace.ts";
import { heardNote, readTriage, triage, triageInput, triageMessages } from "../src/core/triage.ts";
import { ProviderError, type Config, type StackConfig } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-triage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base: Config = {
  locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "a" } } } },
  model: "mac/o/a",
  fallback: ["mac/o/reserve"],
};

/**
 * Fake models: "triage-one" and "triage-stack" answer that word (the first after a line on what the message asks),
 * "triage-mumble" answers neither, "triage-fail" cannot connect, "triage-slow" takes 2 s; the others say who they are.
 */
function fakes() {
  const calls: { model: string; request: ChatRequest }[] = [];
  const router = new Router(base, (name, cfg): Provider => ({
    name,
    model: cfg.model,
    async chat(request) {
      calls.push({ model: cfg.model, request: { ...request, messages: [...request.messages] } });
      const m = cfg.model;
      if (m === "triage-fail") throw new ProviderError(name, "cannot connect");
      if (m === "triage-slow") await new Promise((resolve) => setTimeout(resolve, 2000));
      const text = m === "triage-one" ? "Asks to push what was applied.\none" : m === "triage-stack" ? "Stack" : m === "triage-mumble" ? "I am not sure." : `${m}: ok`;
      request.onDelta?.(text);
      return { text, inputTokens: 10, outputTokens: 2 };
    },
  }));
  return { router, calls };
}

const coding: StackConfig = { purpose: "implementing and fixing the project's code", nodes: { a: { model: "mac/o/a" }, b: { model: "mac/o/b" } } };

test("the triage's answer: the word on its last line, what it said before that, or nothing", () => {
  expect(readTriage("stack")).toEqual({ route: "stack" });
  expect(readTriage("One.")).toEqual({ route: "one" });
  expect(readTriage("**stack**")).toEqual({ route: "stack" });
  expect(readTriage("Asks to push the change.\none")).toEqual({ route: "one", why: "Asks to push the change." });
  // the line on what it asks can say "one": the last line decides
  expect(readTriage("Asks for one quick command.\nstack")).toEqual({ route: "stack", why: "Asks for one quick command." });
  expect(readTriage("I would say one model is enough")?.route).toBe("one");
  // the first word decides: a small model that goes on talking after it (lfm3, 03/11) is not read further
  expect(readTriage("one\n\nWait, let me parse this carefully. Maybe it is the stack's work after all: stack")).toEqual({ route: "one" });
  expect(readTriage("")).toBeUndefined();
  expect(readTriage("I am not sure.")).toBeUndefined();
});

test("the triage reads the stack's purpose, turns that show the answer, and the end of the last answer", () => {
  const messages = triageMessages("answering questions about people: who they are", "quem é brás cubas");
  expect(messages[0]!.content).toContain("The stack is for: answering questions about people: who they are");
  // six turns, then the message; the "stack" turn asks for the purpose's work in its own words
  expect(messages.map((m) => m.role)).toEqual(["system", ...Array(6).fill(["user", "assistant"]).flat(), "user"]);
  expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["one", "one", "stack", "one", "stack", "one"]);
  expect(messages[5]!.content).toBe("New message: answering questions about people, please");
  expect(messages.at(-1)!.content).toBe("New message: quem é brás cubas");
  expect(triageInput("ok para push")).toBe("New message: ok para push");
  const long = "x".repeat(5000) + " Shall I implement slices 3 to 5?";
  const input = triageInput("go ahead", { prompt: "plan it", answer: long });
  expect(input).toContain("Shall I implement slices 3 to 5?");
  expect(input.length).toBeLessThan(2000);
  expect(input.endsWith("New message: go ahead")).toBe(true);
});

test("the triage model answers with no tools, at temperature 0 and with no fallback; what it cannot decide goes to the stack", async () => {
  const { router, calls } = fakes();
  const trace = new Trace(dir, { user: "t", surface: "test" });
  expect(await triage(router, "mac/o/triage-one", "code", "ok para push", undefined, trace)).toMatchObject({ route: "one", why: "Asks to push what was applied.", model: "mac/o/triage-one" });
  expect(calls[0]!.request.tools).toBeUndefined();
  expect(calls[0]!.request.temperature).toBe(0);
  expect(calls[0]!.request.maxTokens).toBe(32);
  expect(calls[0]!.request.messages.at(-1)).toEqual({ role: "user", content: "New message: ok para push" });
  expect((await triage(router, "mac/o/triage-stack", "code", "implement it", undefined, trace)).route).toBe("stack");
  // an answer with neither word, or a model that fails: the stack runs, and why is said; the fallback is not tried
  expect(await triage(router, "mac/o/triage-mumble", "code", "hi", undefined, trace)).toMatchObject({ route: "stack", error: "could not read its answer: I am not sure." });
  const before = calls.length;
  expect(await triage(router, "mac/o/triage-fail", "code", "hi", undefined, trace)).toMatchObject({ route: "stack", error: "cannot connect" });
  expect(calls.slice(before).map((c) => c.model)).toEqual(["triage-fail"]);
});

test("Esc stops the triage: it throws instead of sending the message anywhere", async () => {
  const { router } = fakes();
  const trace = new Trace(dir, { user: "t", surface: "test" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = performance.now();
  // the fake does not listen to the signal: the triage's own check, when the answer comes back, is what throws
  await expect(triage(router, "mac/o/triage-slow", "code", "hi", undefined, trace, controller.signal)).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(3000);
});

test("a stack triages only with the config's triage model and its own purpose; the decision goes to the trace", async () => {
  const { router } = fakes();
  const trace = new Trace(dir, { user: "t", surface: "test" });
  let model: string | undefined = "mac/o/triage-one";
  const runner = new StackRunner(router, trace, "code", coding, { triage: () => model });
  expect(runner.triages).toBe(true);
  expect(await runner.triage("ok para push")).toMatchObject({ route: "one" });
  // the person turned it off (/triage off): read again at each message
  model = undefined;
  expect(runner.triages).toBe(false);
  expect(await runner.triage("ok para push")).toBeUndefined();
  const noPurpose = new StackRunner(router, trace, "any", { nodes: coding.nodes }, { triage: () => "mac/o/triage-one" });
  expect(noPurpose.triages).toBe(false);
  const events = readTrace(dir, trace.id);
  const decided = events.filter((e) => e.type === "triage");
  expect(decided).toHaveLength(1);
  expect(decided[0]).toMatchObject({ type: "triage", stack: "code", model: "mac/o/triage-one", route: "one", content: "ok para push" });
  // the triage's own request and answer carry the stack's tags, so the stats count them for the model, not as a question
  expect(events.find((e) => e.type === "response")).toMatchObject({ stack: "code", node: "triage" });
  expect(events.some((e) => e.type === "prompt")).toBe(false);
});

test("what one model answered outside the stack reaches every node with its next prompt, even one that had not run yet", async () => {
  const { router, calls } = fakes();
  const trace = new Trace(dir, { user: "t", surface: "test" });
  const runner = new StackRunner(router, trace, "code", coding, { triage: () => "mac/o/triage-one" });
  runner.note({ prompt: "ok para push", answer: "Pushed to origin." });
  await runner.send("now fix the login");
  const prompts = calls.filter((c) => c.model === "a" || c.model === "b").map((c) => c.request.messages.at(-1)!.content);
  expect(prompts).toHaveLength(2);
  for (const p of prompts) {
    expect(p).toContain("Meanwhile, one model alone");
    expect(p).toContain("Pushed to origin.");
    expect(p.endsWith("now fix the login")).toBe(true);
  }
  // heard once: the next prompt does not carry it again
  calls.length = 0;
  await runner.send("thanks");
  for (const c of calls) expect(c.request.messages.at(-1)!.content).toBe("thanks");
  expect(heardNote({ prompt: "p", answer: "y".repeat(5000) }, "the stack code").length).toBeLessThan(3200);
});

test("the config's triage: its model must exist, a rename follows it and removing its location turns it off", () => {
  const config = validateConfig({ ...base, triage: { model: "mac/o/small" }, stacks: { code: coding }, stack: "code" });
  expect(config.triage?.model).toBe("mac/o/small");
  expect(() => validateConfig({ ...base, triage: { model: "nowhere/x" } })).toThrow('triage model "nowhere/x"');
  expect(() => validateConfig({ ...base, triage: "mac/o/small" })).toThrow('"triage" is { "model": "location/provider/model" }');
  expect(() => validateConfig({ ...base, stacks: { code: { ...coding, purpose: " " } } })).toThrow('"purpose" is the work the stack is for');
  expect(setTriage(config, "mac/o/other").triage).toEqual({ model: "mac/o/other" });
  expect(setTriage(config).triage).toBeUndefined();
  const two: Config = { ...config, locations: { ...config.locations, gpu: { type: "machine", providers: { o: { type: "server", port: 2, model: "s" } } } }, triage: { model: "gpu/o/s" } };
  const { config: without, changed } = removeLocation(validateConfig(two), "gpu");
  expect(without.triage).toBeUndefined();
  expect(changed.join(" ")).toContain("triage model gpu/o/s removed");
});

test("warming the triage calls its model once, in the background, decides nothing and leaves no trace", async () => {
  const { router, calls } = fakes();
  const trace = new Trace(dir, { user: "t", surface: "test" });
  new StackRunner(router, trace, "code", coding, { triage: () => "mac/o/triage-stack" }).warmTriage();
  // no purpose, or no model: nothing is called
  new StackRunner(router, trace, "any", { nodes: coding.nodes }, { triage: () => "mac/o/triage-stack" }).warmTriage();
  new StackRunner(router, trace, "code", coding, { triage: () => undefined }).warmTriage();
  await Bun.sleep(50);
  expect(calls.map((c) => c.model)).toEqual(["triage-stack"]);
  // a Kli that opens and closes leaves no empty session behind
  expect(readTrace(dir, trace.id)).toEqual([]);
});
