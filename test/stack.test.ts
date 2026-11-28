import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { nodeLine } from "../src/cli/output.ts";
import { putLocation, removeLocation, setStack, validateConfig } from "../src/core/config.ts";
import type { ChatRequest, Provider } from "../src/core/providers/provider.ts";
import { Router } from "../src/core/router.ts";
import { StackRunner, type NodeResult } from "../src/core/stack-run.ts";
import { adherence, joinPrompt, readChoice, readContributions, readVerdict, stackOrder, stackOutputs, stackProblems, TagCut } from "../src/core/stack.ts";
import { collectStats } from "../src/core/stats.ts";
import { readTrace, Trace } from "../src/core/trace.ts";
import { ProviderError, type Config, type StackConfig } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-stack-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base: Config = {
  locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "a" } } } },
  model: "mac/o/a",
  fallback: ["mac/o/reserve"],
};

/**
 * Fake models, by name: "slow-…" takes 200 ms (the text starts at 150), "fail-…" cannot connect, "tool-ls" and
 * "tool-touch" ask for that command first, "hang-…" answers only when stopped, "cli-narra" narrates like a CLI agent
 * before its last message, "judge-rounds" judges the answers it gets, round by round; "halfway" says what it will do,
 * then fails, as the Antigravity did at a refused permission;
 * every model says who it is and what it got, and each call is kept, with when it came.
 */
function fakes() {
  const calls: { model: string; request: ChatRequest; at: number }[] = [];
  const router = new Router(base, (name, cfg): Provider => ({
    name,
    model: cfg.model,
    async chat(request) {
      calls.push({ model: cfg.model, request: { ...request, messages: [...request.messages] }, at: performance.now() });
      const m = cfg.model;
      if (m.startsWith("fail")) throw new ProviderError(name, "cannot connect");
      if (m === "halfway") {
        request.onDelta?.("Vou ler o plano.\n");
        throw new ProviderError(name, "stopped at a refused permission (McpTool): agy ends the run there", true);
      }
      const last = request.messages.at(-1)!;
      if (m.startsWith("hang"))
        await new Promise((_, reject) => {
          const stop = () => reject(new ProviderError(name, "interrupted"));
          if (request.signal?.aborted) stop();
          request.signal?.addEventListener("abort", stop);
        });
      // what it would do, its steps, then its last message (the CLI tells which part that is)
      if (m === "cli-narra") {
        for (const piece of ["Vou ler os arquivos.\n", "A resposta é 4."]) request.onDelta?.(piece);
        return { text: "Vou ler os arquivos.\nA resposta é 4.", final: "A resposta é 4.", inputTokens: 10, outputTokens: 8 };
      }
      // the first round lists the requirements; a later one marks them (and lists one more, which must be left out)
      if (m === "judge-rounds") {
        const labels = [...last.content.matchAll(/<answer id="([A-Z])">/g)].map((x) => x[1]!);
        const later = last.content.includes("More answers to judge");
        const answers = Object.fromEntries(labels.map((l) => [l, later ? { items: ["met", "partial"], note: "três frases" } : { items: ["met", "met"] }]));
        return { text: JSON.stringify({ requirements: later ? ["inventado"] : ["diz o que é", "em duas frases"], answers }), inputTokens: 40, outputTokens: 20 };
      }
      // an aggregator whose contributions block comes split between pieces
      if (m === "agg") {
        for (const piece of ["Resposta junta", " final.\n<contri", 'butions>{"A": 70, "B": 30}</contributions>']) request.onDelta?.(piece);
        return { text: 'Resposta junta final.\n<contributions>{"A": 70, "B": 30}</contributions>', inputTokens: 30, outputTokens: 12 };
      }
      // a verifier: a verdict in a code fence; "judge-late" first answers in words, then in JSON when asked again
      const verdict = '```json\n{"requirements": ["diz o que é", "em duas frases"], "answers": {"A": {"items": ["met", "met"]}, "B": {"items": ["met", "partial"], "note": "três frases"}, "C": {"items": ["missing"]}}}\n```';
      if (m === "judge" || (m === "judge-late" && last.content.startsWith("Reply with the JSON only"))) {
        request.onDelta?.(verdict);
        return { text: verdict, inputTokens: 40, outputTokens: 30 };
      }
      if (m.startsWith("judge")) return { text: "As duas respostas estão boas.", inputTokens: 40, outputTokens: 6 };
      // a chooser picks B; "chooser-late" first answers in words; "chooser-never" never in JSON
      const pick = '{"choice": "B", "why": "segue o formato pedido"}';
      if (m === "chooser" || (m === "chooser-late" && last.content.startsWith("Reply with the JSON only"))) return { text: pick, inputTokens: 20, outputTokens: 9 };
      if (m.startsWith("chooser")) return { text: "Eu escolheria a segunda.", inputTokens: 20, outputTokens: 5 };
      if (m.startsWith("tool") && last.role === "user")
        return { text: "", toolCalls: [{ id: "t1", name: "Bash", input: { command: m === "tool-touch" ? "touch x.txt" : "ls" } }], inputTokens: 5, outputTokens: 1 };
      if (m.startsWith("slow")) await Bun.sleep(150);
      request.onDelta?.(`${m}: `);
      if (m.startsWith("slow")) await Bun.sleep(50);
      // thought for 100 tokens before the text, then 40 tokens of text in 400 ms
      if (m.startsWith("think")) {
        await Bun.sleep(400);
        return { text: `${m}: ${last.content.slice(0, 40)}`, inputTokens: 10, outputTokens: 140, thinkingTokens: 100 };
      }
      return { text: `${m}: ${last.content.slice(0, 40)}`, inputTokens: 10, outputTokens: 4 };
    },
  }));
  return { router, calls };
}
const trace = () => new Trace(dir, { user: "test", surface: "test" });
const stackOf = (nodes: StackConfig["nodes"]): StackConfig => ({ nodes });

test("a stack's shape: inputs that exist, no circles, someone gets the prompt", () => {
  expect(stackProblems("s", { nodes: {} })).toEqual(['stack "s": it has no nodes']);
  expect(stackProblems("s", stackOf({ a: { model: "mac/o/a", from: ["z"] } }))).toEqual(['stack "s": node "a" gets from "z", which is not a node']);
  expect(stackProblems("s", stackOf({ a: { model: "mac/o/a", from: ["b"] }, b: { model: "mac/o/b", from: ["a"] } }))).toEqual([
    'stack "s": no node gets the prompt (every node has "from")',
    'stack "s": it goes round in a circle: a → b → a',
  ]);
  expect(stackProblems("s", stackOf({ a: { model: "" }, b: { model: "mac/o/b", from: ["a"], min: 2 }, c: { model: "mac/o/c", tools: "all" as "read" } }))).toEqual([
    'stack "s": node "a": missing "model"',
    'stack "s": node "b": min is between 1 and the number of nodes it gets from',
    'stack "s": node "c": tools is "read", "write" or "none"',
  ]);
});

test("the order puts each node after its inputs; the outputs are the ends, or the ones marked", () => {
  const s = stackOf({ judge: { model: "mac/o/j", from: ["join"] }, join: { model: "mac/o/x", from: ["a", "b"] }, a: { model: "mac/o/a" }, b: { model: "mac/o/b" } });
  expect(stackOrder(s)).toEqual(["a", "b", "join", "judge"]);
  expect(stackOutputs(s)).toEqual(["judge"]);
  expect(stackOutputs(stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" } }))).toEqual(["a", "b"]);
  s.nodes.join!.output = true;
  expect(stackOutputs(s)).toEqual(["join"]);
});

test("in the config: stacks are checked, the chosen one must exist, and a model that goes away does not break it", () => {
  const stacks = { duo: stackOf({ a: { model: "mac/o/a" }, b: { model: "box/o/b" } }) };
  expect(() => validateConfig({ ...base, stacks, stack: "trio" })).toThrow('stack "trio" is not one of the stacks');
  expect(() => validateConfig({ ...base, stacks: { "bad name": stackOf({ a: { model: "mac/o/a" } }) } })).toThrow("use letters");
  // box is not a location: the stack says so when it runs, the config still loads
  expect(validateConfig({ ...base, stacks, stack: "duo" }).stack).toBe("duo");
  expect(setStack({ ...base, stacks, stack: "duo" }).stack).toBeUndefined();
  // renaming a location follows into the nodes; removing it leaves the node, and says so
  const withBox = putLocation({ ...base, stacks }, "box", { type: "machine", providers: { o: { type: "server", port: 2 } } });
  expect(putLocation(withBox, "caixa", withBox.locations.box!, "box").stacks!.duo!.nodes.b!.model).toBe("caixa/o/b");
  expect(removeLocation(withBox, "box").changed).toEqual(["stack duo: node b has no model now"]);
});

test("--stack lets a stack answer this time; it does not go with --model", () => {
  expect(parseArgs(["--stack", "duo", "-p", "oi"])).toMatchObject({ command: "prompt", stack: "duo", prompt: "oi" });
  expect(() => parseArgs(["--stack", "duo", "-m", "mac/o/a", "oi"])).toThrow("choose one");
});

test("the nodes without inputs run at the same time; a join gets the request and the answers, by letter", async () => {
  const { router, calls } = fakes();
  const s = stackOf({ a: { model: "mac/o/slow-a" }, b: { model: "mac/o/slow-b" }, join: { model: "mac/o/join", from: ["a", "b"] } });
  const runner = new StackRunner(router, trace(), "s", s);
  const r = await runner.send("quanto é 2+2?");
  // two 200 ms nodes side by side, then the join
  expect(r.ms).toBeLessThan(380);
  expect(r.nodeMs).toBeGreaterThanOrEqual(400);
  expect(r.outputs.map((o) => o.node)).toEqual(["join"]);
  const join = calls.find((c) => c.model === "join")!.request.messages.at(-1)!.content;
  expect(join).toBe(joinPrompt("quanto é 2+2?", [{ label: "A", text: "slow-a: quanto é 2+2?" }, { label: "B", text: "slow-b: quanto é 2+2?" }]));
  // the join never sees which models answered
  expect(join).not.toContain("mac/o");
});

test("two outputs side by side, measured one by one", async () => {
  const { router } = fakes();
  const runner = new StackRunner(router, trace(), "compare", stackOf({ left: { model: "mac/o/a" }, right: { model: "mac/o/slow-b" } }));
  const r = await runner.send("oi");
  expect(r.outputs.map((o) => [o.node, o.status, o.text])).toEqual([
    ["left", "ok", "a: oi"],
    ["right", "ok", "slow-b: oi"],
  ]);
  const right = r.outputs[1]!;
  expect(right).toMatchObject({ answeredBy: "mac/o/slow-b", inputTokens: 10, outputTokens: 4, steps: 1 });
  expect(right.firstTokenMs).toBeGreaterThanOrEqual(140);
  // its text came in 50 ms: too short to give a speed
  expect(right.tokensPerSecond).toBeUndefined();
  expect(r).toMatchObject({ inputTokens: 20, outputTokens: 8 });
});

test("the speed counts the text, not the thinking that came before it", async () => {
  const { router } = fakes();
  const r = await new StackRunner(router, trace(), "s", stackOf({ t: { model: "mac/o/think" } })).send("oi");
  const t = r.outputs[0]!;
  expect(t).toMatchObject({ outputTokens: 140, thinkingTokens: 100 });
  // 40 tokens of text in ~400 ms: about 100 per second, not 140 / 0.4 = 350
  expect(t.tokensPerSecond).toBeGreaterThan(80);
  expect(t.tokensPerSecond).toBeLessThan(110);
});

test("a node that fails: the join goes on with what answered and does what the other did not; the config's fallback is not used", async () => {
  const { router, calls } = fakes();
  const s = stackOf({ a: { model: "mac/o/fail-a" }, b: { model: "mac/o/b" }, one: { model: "mac/o/one", from: ["a", "b"] }, both: { model: "mac/o/both", from: ["a", "b"], min: 2 } });
  const r = await new StackRunner(router, trace(), "s", s).send("oi");
  const by = Object.fromEntries(r.nodes.map((n) => [n.node, n]));
  expect(by.a).toMatchObject({ status: "failed", error: "mac/o: cannot connect" });
  expect(by.one!.status).toBe("ok");
  const got = calls.find((c) => c.model === "one")!.request.messages.at(-1)!.content;
  expect(got).toContain('<answer from="B">');
  expect(got).toContain("Step A did not answer: do yourself what it was to do.");
  // a stack does not stop (12/11/2026): "min" no longer holds back a step that answers
  expect(by.both!.status).toBe("ok");
  // a comparison would lie if another model answered in a node's place
  expect(calls.some((c) => c.model === "reserve")).toBe(false);
  // a node's own fallback is fine: it is part of the stack
  const own = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/fail-a", fallback: ["mac/o/spare"] } })).send("oi");
  expect(own.outputs[0]).toMatchObject({ status: "ok", model: "mac/o/fail-a", answeredBy: "mac/o/spare" });
});

test("a stack does not stop: the step after one that failed gets what it said, unfinished, or answers alone; a chooser or a judge with nothing is skipped", async () => {
  const { router, calls } = fakes();
  // what the failed step said before it stopped goes on, marked unfinished
  const chain = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/halfway" }, b: { model: "mac/o/b", from: ["a"] } })).send("oi");
  expect(chain.nodes.map((n) => n.status)).toEqual(["failed", "ok"]);
  expect(chain.nodes[0]).toMatchObject({ text: "Vou ler o plano.\n", error: "mac/o: stopped at a refused permission (McpTool): agy ends the run there" });
  const got = calls.find((c) => c.model === "b")!.request.messages.at(-1)!.content;
  expect(got).toContain('<answer from="A" unfinished="its step failed before it ended">\nVou ler o plano.\n</answer>');
  expect(got).toContain("An answer marked unfinished stopped before it ended: use what is right in it, and do yourself what it did not get to.");
  expect(chain.outputs[0]).toMatchObject({ node: "b", status: "ok" });
  // nothing came: the step answers the request alone, and an aggregator too
  const alone = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/fail-a" }, b: { model: "mac/o/b", from: ["a"] }, j: { model: "mac/o/j", role: "aggregate", from: ["a"] } })).send("oi");
  expect(alone.nodes.map((n) => [n.node, n.status])).toEqual([["a", "failed"], ["b", "ok"], ["j", "ok"]]);
  expect(calls.find((c) => c.model === "j")!.request.messages.at(-1)!.content).toBe("<request>\noi\n</request>\n\nStep A did not answer: do yourself what it was to do.\n\nAnswer the request.");
  // a chooser and a judge have nothing to do without answers: skipped, saying which did not come
  const none = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/fail-a" }, c: { model: "mac/o/chooser", role: "choose", from: ["a"] }, v: { model: "mac/o/judge", role: "verify", from: ["a"] } })).send("oi");
  const n = Object.fromEntries(none.nodes.map((x) => [x.node, x]));
  expect(n.c).toMatchObject({ status: "skipped", error: "0 of 1 inputs answered (a did not)" });
  expect(n.v).toMatchObject({ status: "skipped", error: "0 of 1 inputs answered (a did not)" });
});

test("a node's model that is not in the config fails that node, not the stack", async () => {
  const { router } = fakes();
  const r = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "box/o/a" }, b: { model: "mac/o/b" } })).send("oi");
  expect(r.nodes.map((n) => n.status)).toEqual(["failed", "ok"]);
  expect(r.nodes[0]!.error).toContain('location "box" is not declared');
});

test("each node goes on from its own conversation on the next prompt", async () => {
  const { router, calls } = fakes();
  const runner = new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" } }));
  await runner.send("primeira");
  await runner.send("segunda");
  const second = calls.filter((c) => c.model === "a").at(-1)!.request.messages.map((m) => `${m.role}: ${m.content}`);
  expect(second).toEqual(["user: primeira", "assistant: a: primeira", "user: segunda"]);
});

test("the trace: one prompt for the stack, each node's events tagged, and the stats count it once", async () => {
  const { router } = fakes();
  const t = trace();
  await new StackRunner(router, t, "s", stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/fail-b" }, j: { model: "mac/o/j", from: ["a", "b"] } })).send("oi");
  const events = readTrace(dir, t.id);
  expect(events.filter((e) => !e.node).map((e) => e.type)).toEqual(["start", "prompt", "stack", "stack"]);
  const nodes = events.filter((e) => e.type === "node");
  expect(nodes.map((e) => [e.node, e.type === "node" && e.status])).toEqual([
    ["a", "ok"],
    ["b", "failed"],
    ["j", "ok"],
  ]);
  expect(events.every((e) => !e.node || e.stack === "s")).toBe(true);
  const stats = collectStats(dir, { sessions: [t.id] } as never);
  expect(stats.prompts).toBe(1);
  expect(stats.outcomes).toEqual({ answered: 1, failed: 0, interrupted: 0 });
});

test("a node's tools only read, so nodes side by side never ask the person anything", async () => {
  const root = join(dir, "pasta");
  mkdirSync(root);
  writeFileSync(join(root, "vendas.csv"), "a\n");
  const { router, calls } = fakes();
  const runner = new StackRunner(router, trace(), "s", stackOf({ lists: { model: "mac/o/tool-ls" }, writes: { model: "mac/o/tool-touch" }, none: { model: "mac/o/a", tools: "none" } }), { root });
  const r = await runner.send("liste os arquivos; touch se precisar");
  await runner.close();
  const by = Object.fromEntries(r.nodes.map((n) => [n.node, n]));
  expect(by.lists!.tools).toEqual([{ name: "Bash", label: "Bash(ls)", ok: true }]);
  expect(by.writes!.tools).toEqual([{ name: "Bash", label: "Bash(touch x.txt)", ok: false }]);
  expect(calls.find((c) => c.model === "a")!.request.tools).toBeUndefined();
  expect(calls.find((c) => c.model === "tool-ls")!.request.tools!.map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "Bash", "BashOutput", "KillBash"]);
  // it is told so: small models take "write a text" for "write a file"
  expect(calls.find((c) => c.model === "tool-ls")!.request.messages[0]!.content).toContain("In this step your tools only read");
  expect(calls.find((c) => c.model === "a")!.request.messages[0]?.content ?? "").not.toContain("your tools only read");
  // the tokens of a tool step are not text: no speed for a node that used tools
  expect(by.lists!.steps).toBe(2);
  expect(by.lists!.tokensPerSecond).toBeUndefined();
});

test("Esc stops every node, and the stack says it was interrupted", async () => {
  const { router } = fakes();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const t = trace();
  const runner = new StackRunner(router, t, "s", stackOf({ a: { model: "mac/o/slow-a" }, j: { model: "mac/o/j", from: ["a"] } }));
  const error = await runner.send("oi", { signal: controller.signal }).catch((e) => e);
  expect(error.name).toBe("AbortError");
  expect(error.result.nodes.map((n: { status: string }) => n.status)).toEqual(["ok", "interrupted"]);
  expect(readTrace(dir, t.id).find((e) => e.type === "stack" && e.phase === "end")).toMatchObject({ ok: false, interrupted: true });
});


test("roles: a verifier only judges (never an answer of the stack); aggregating or verifying needs inputs", () => {
  expect(stackProblems("s", stackOf({ a: { model: "m/a", role: "judge" as "verify" }, b: { model: "m/b", role: "verify" } }))).toEqual([
    'stack "s": node "a": role is answer, aggregate, verify, choose, ground',
    'stack "s": node "b": to verify, it needs "from" (the answers it gets)',
  ]);
  const s = stackOf({ a: { model: "m/a" }, b: { model: "m/b" }, junta: { model: "m/j", role: "aggregate", from: ["a", "b"] }, v: { model: "m/v", role: "verify", from: ["junta", "a", "b"] } });
  expect(stackOutputs(s)).toEqual(["junta"]);
  // judging two side-by-side answers leaves both as answers
  expect(stackOutputs(stackOf({ a: { model: "m/a" }, b: { model: "m/b" }, v: { model: "m/v", role: "verify", from: ["a", "b"] } }))).toEqual(["a", "b"]);
});

test("a streamed text keeps out what comes from a tag on, even when the tag arrives in pieces", () => {
  const cut = new TagCut("contributions");
  expect(["Olá, ", "mundo.\n<con", "tributions>{}", "</contributions>"].map((p) => cut.push(p)).join("") + cut.end()).toBe("Olá, mundo.\n");
  const plain = new TagCut("contributions");
  expect(["a <b", "> c <con"].map((p) => plain.push(p)).join("") + plain.end()).toBe("a <b> c <con");
});

test("an aggregator's block: the shares by letter, made to add up to 100; without it, just the text", () => {
  expect(readContributions('Texto.\n<contributions>{"A": 2, "B": 1, "C": "x"}</contributions>')).toEqual({ text: "Texto.", shares: { A: 67, B: 33 } });
  expect(readContributions("Texto sem bloco.")).toEqual({ text: "Texto sem bloco." });
  expect(readContributions("Texto.\n<contributions>nada</contributions>")).toEqual({ text: "Texto." });
});

test("a verdict: read from words or a code fence, one mark per requirement (what is left out is missing), adherence from the marks", () => {
  expect(adherence(["met", "partial", "missing", "met"])).toBe(63);
  const v = readVerdict('Aqui está:\n```json\n{"requirements": ["r1", "r2", ""], "answers": {"A": {"items": ["met", "partial"], "note": " curta "}, "Z": {"items": ["met"]}}}\n```', { A: "junta", B: "desk" });
  expect(v).toEqual({ requirements: ["r1", "r2"], judged: [{ node: "junta", items: ["met", "partial"], adherence: 75, note: "curta" }] });
  expect(readVerdict("Sem JSON nenhum.", { A: "a" })).toBeUndefined();
  expect(readVerdict('{"requirements": [], "answers": {}}', { A: "a" })).toBeUndefined();
});

test("an aggregator joins, says how much came from each, and its block never reaches the screen", async () => {
  const { router, calls } = fakes();
  const deltas: string[] = [];
  const t = trace();
  const r = await new StackRunner(router, t, "s", stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, junta: { model: "mac/o/agg", role: "aggregate", from: ["a", "b"] } }), { root: dir }).send("oi", {
    onEvent: (e) => e.type === "delta" && e.node === "junta" && deltas.push(e.text),
  });
  expect(deltas.join("")).toBe("Resposta junta final.\n");
  expect(r.outputs[0]).toMatchObject({ node: "junta", role: "aggregate", text: "Resposta junta final.", contributions: { a: 70, b: 30 } });
  const asked = calls.find((c) => c.model === "agg")!.request;
  expect(asked.messages.at(-1)!.content).toContain('<answer from="A">\na: oi\n</answer>');
  // it works on the answers: no tools, even with a folder
  expect(asked.tools).toBeUndefined();
  expect(readTrace(dir, t.id).find((e) => e.type === "node" && e.node === "junta")).toMatchObject({ contributions: { a: 70, b: 30 } });
});

test("a verifier judges what it gets against the request, quietly, and is not an answer", async () => {
  const { router } = fakes();
  const deltas: string[] = [];
  const t = trace();
  const s = stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, v: { model: "mac/o/judge", role: "verify", from: ["a", "b"] } });
  const r = await new StackRunner(router, t, "s", s).send("o que é um golem? em duas frases", { onEvent: (e) => e.type === "delta" && e.node === "v" && deltas.push(e.text) });
  expect(deltas).toEqual([]);
  expect(r.outputs.map((o) => o.node)).toEqual(["a", "b"]);
  const v = r.nodes.find((n) => n.node === "v")!;
  expect(v.verdict).toEqual({
    requirements: ["diz o que é", "em duas frases"],
    judged: [
      { node: "a", items: ["met", "met"], adherence: 100 },
      { node: "b", items: ["met", "partial"], adherence: 75, note: "três frases" },
    ],
  });
  expect(readTrace(dir, t.id).find((e) => e.type === "node" && e.node === "v")).toMatchObject({ verdict: { judged: [{ node: "a", adherence: 100 }, { node: "b", adherence: 75 }] } });
});

test("whoever judges sees the tools each answer used, after its words; a step with none shows none", async () => {
  const root = join(dir, "pasta-juiz");
  mkdirSync(root);
  const { router, calls } = fakes();
  const s = stackOf({ lists: { model: "mac/o/tool-ls" }, writes: { model: "mac/o/tool-touch" }, none: { model: "mac/o/a", tools: "none" }, v: { model: "mac/o/judge", role: "verify", from: ["lists", "writes", "none"] } });
  const runner = new StackRunner(router, trace(), "s", s, { root });
  await runner.send("liste os arquivos");
  await runner.close();
  const got = calls.filter((c) => c.model === "judge").map((c) => c.request.messages.at(-1)!.content).join("\n");
  expect(got).toContain('<tools used="1">Bash(ls)</tools>\n</answer>');
  expect(got).toContain('<tools used="1">Bash(touch x.txt) (failed)</tools>\n</answer>');
  expect(got).toContain('<answer id="C">\na: liste os arquivos\n</answer>');
  expect(got).toContain("In <tools>, after an answer's words: the tools its step used to answer");
});

test("a CLI's narration stays on screen and in the trace; the next nodes get only its last message", async () => {
  const { router, calls } = fakes();
  const t = trace();
  const s = stackOf({ cli: { model: "mac/o/cli-narra" }, b: { model: "mac/o/b" }, join: { model: "mac/o/join", from: ["cli", "b"] }, v: { model: "mac/o/judge", role: "verify", from: ["cli", "b"] } });
  const deltas: string[] = [];
  const r = await new StackRunner(router, t, "s", s).send("quanto é 2+2?", { onEvent: (e) => e.type === "delta" && e.node === "cli" && deltas.push(e.text) });
  const cli = r.nodes.find((n) => n.node === "cli")!;
  expect(deltas.join("")).toBe("Vou ler os arquivos.\nA resposta é 4.");
  expect(cli).toMatchObject({ text: "Vou ler os arquivos.\nA resposta é 4.", answer: "A resposta é 4." });
  for (const model of ["join", "judge"]) {
    const got = calls.filter((c) => c.model === model).map((c) => c.request.messages.at(-1)!.content).join("\n");
    expect(got).toContain('<answer from="A">\nA resposta é 4.\n</answer>'.replace("from", model === "join" ? "from" : "id"));
    expect(got).not.toContain("Vou ler");
  }
  expect(readTrace(dir, t.id).find((e) => e.type === "node" && e.node === "cli")).toMatchObject({ content: "Vou ler os arquivos.\nA resposta é 4.", answerChars: 15 });
});

test("the judge does not wait for the slowest: it judges what came, then the rest in another round, on the same requirements", async () => {
  const { router, calls } = fakes();
  const t = trace();
  const s = stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/slow-b" }, v: { model: "mac/o/judge-rounds", role: "verify", from: ["a", "b"] } });
  const doing: string[] = [];
  const r = await new StackRunner(router, t, "s", s).send("o que é CSV? em duas frases", { onEvent: (e) => e.type === "doing" && doing.push(e.what) });
  const judge = calls.filter((c) => c.model === "judge-rounds");
  const prompts = judge.map((c) => c.request.messages.at(-1)!.content);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('<answer id="A">');
  expect(prompts[0]).not.toContain('<answer id="B">');
  expect(prompts[1]).toContain("More answers to judge:");
  expect(prompts[1]).toContain('<answer id="B">');
  expect(prompts[1]).toContain("only these, in this order:\n   1. diz o que é\n   2. em duas frases");
  // the first round began while b was still answering, and the second goes on from it (its conversation has A)
  expect(judge[0]!.at - calls.find((c) => c.model === "slow-b")!.at).toBeLessThan(150);
  expect(judge[1]!.request.messages.some((m) => m.content.includes('<answer id="A">'))).toBe(true);
  expect(doing).toContain("judged a · waits for b");
  const v = r.nodes.find((n) => n.node === "v")!;
  // the requirements are the first round's: the one the later round listed is left out
  expect(v.verdict).toEqual({
    requirements: ["diz o que é", "em duas frases"],
    judged: [
      { node: "a", items: ["met", "met"], adherence: 100 },
      { node: "b", items: ["met", "partial"], adherence: 75, note: "três frases" },
    ],
  });
  // its time and tokens are its two rounds, not the wait for b
  expect(v).toMatchObject({ status: "ok", rounds: 2, steps: 2, inputTokens: 80 });
  expect(v.ms).toBeLessThan(100);
  expect(nodeLine(v, false)).toMatch(/s in 2 rounds · .* · adherence a 100 · b 75$/);
  expect(readTrace(dir, t.id).find((e) => e.type === "node" && e.node === "v")).toMatchObject({ rounds: 2 });

  // with min, the first round waits for that many answers
  const { router: r2, calls: c2 } = fakes();
  const min2 = stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, c: { model: "mac/o/slow-c" }, v: { model: "mac/o/judge-rounds", role: "verify", from: ["a", "b", "c"], min: 2 } });
  await new StackRunner(r2, trace(), "s", min2).send("oi");
  const first = c2.find((c) => c.model === "judge-rounds")!.request.messages.at(-1)!.content;
  expect([first.includes('<answer id="A">'), first.includes('<answer id="B">'), first.includes('<answer id="C">')]).toEqual([true, true, false]);
});

test("Esc while the slowest still works: the judge keeps the verdict of what it judged", async () => {
  const { router } = fakes();
  const s = stackOf({ a: { model: "mac/o/a" }, h: { model: "mac/o/hang-h" }, v: { model: "mac/o/judge-rounds", role: "verify", from: ["a", "h"] } });
  const controller = new AbortController();
  const stopped = await new StackRunner(router, trace(), "s", s)
    .send("o que é CSV?", { signal: controller.signal, onEvent: (e) => e.type === "doing" && e.what.startsWith("judged a") && controller.abort() })
    .then(() => undefined, (e: Error & { result?: { nodes: NodeResult[] } }) => e);
  expect(stopped?.name).toBe("AbortError");
  const nodes = stopped!.result!.nodes;
  const v = nodes.find((n) => n.node === "v")!;
  expect(nodes.find((n) => n.node === "h")!.status).toBe("interrupted");
  expect(v.status).toBe("interrupted");
  expect(v.verdict!.judged.map((j) => [j.node, j.adherence])).toEqual([["a", 100]]);
  expect(nodeLine(v, false)).toContain("interrupted · adherence a 100");
});

test("a verdict in the wrong shape is asked for once more; twice wrong, adherence is not measured", async () => {
  const { router } = fakes();
  const late = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/a" }, v: { model: "mac/o/judge-late", role: "verify", from: ["a"] } })).send("oi");
  expect(late.nodes[1]).toMatchObject({ status: "ok", steps: 2, inputTokens: 80 });
  expect(late.nodes[1]!.verdict!.judged[0]!.node).toBe("a");
  const never = await new StackRunner(router, trace(), "s", stackOf({ a: { model: "mac/o/a" }, v: { model: "mac/o/judge-never", role: "verify", from: ["a"] } })).send("oi");
  expect(never.nodes[1]).toMatchObject({ status: "failed", error: "its verdict did not come in the shape asked, twice: adherence not measured" });
});


test("choosing: it needs inputs, 'by' only goes with choose, and the chooser is the answer of the stack", () => {
  expect(stackProblems("s", stackOf({ a: { model: "m/a" }, c: { model: "m/c", role: "choose" }, d: { model: "m/d", by: ["model"], from: ["a"] }, e: { model: "m/e", role: "choose", from: ["a"], by: ["oracle" as "model"] } }))).toEqual([
    'stack "s": node "c": to choose, it needs "from" (the answers it gets)',
    'stack "s": node "d": "by" is for a node that chooses (role "choose")',
    'stack "s": node "e": by is a list of model, person, decision, in the order to try',
  ]);
  expect(stackOutputs(stackOf({ a: { model: "m/a" }, b: { model: "m/b" }, c: { model: "m/c", role: "choose", from: ["a", "b"] } }))).toEqual(["c"]);
  expect(readChoice('Fico com a B: {"choice": "b", "why": "mais curta"}', { A: "gpubox", B: "desk" })).toEqual({ label: "B", node: "desk", why: "mais curta" });
  expect(readChoice('{"choice": "C"}', { A: "gpubox", B: "desk" })).toBeUndefined();
});

test("a model chooses: the chosen answer is the stack's, and every branch goes on from it on the next prompt", async () => {
  const { router, calls } = fakes();
  const t = trace();
  const deltas: string[] = [];
  const runner = new StackRunner(router, t, "s", stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, c: { model: "mac/o/chooser", role: "choose", from: ["a", "b"] } }));
  const r = await runner.send("oi", { onEvent: (e) => e.type === "delta" && e.node === "c" && deltas.push(e.text) });
  expect(r.outputs[0]).toMatchObject({ node: "c", role: "choose", status: "ok", text: "b: oi", choice: { node: "b", label: "B", by: "model", why: "segue o formato pedido" } });
  expect(deltas).toEqual(["b: oi"]);
  // the model saw the answers by letter, never which model wrote them
  expect(calls.find((c) => c.model === "chooser")!.request.messages.at(-1)!.content).toContain('<answer id="A">\na: oi\n</answer>');
  expect(readTrace(dir, t.id).find((e) => e.type === "node" && e.node === "c")).toMatchObject({ choice: { node: "b", by: "model" } });
  await runner.send("e agora?");
  // a, which lost, goes on from b's answer
  expect(calls.filter((c) => c.model === "a").at(-1)!.request.messages.map((m) => m.content)).toEqual(["oi", "b: oi", "e agora?"]);
});

test("who chooses, in order: no person to ask and no decision model yet, so the model; nobody left, the node fails saying why", async () => {
  const { router } = fakes();
  const stack = (by: ("model" | "person" | "decision")[], model = "mac/o/chooser") => stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, c: { model, role: "choose", from: ["a", "b"], by } });
  const r = await new StackRunner(router, trace(), "s", stack(["decision", "person", "model"])).send("oi");
  expect(r.outputs[0]!.choice).toEqual({ node: "b", label: "B", by: "model", why: "segue o formato pedido", passed: ["decision: no decision model yet", "person: no one to ask here"] });
  const nobody = await new StackRunner(router, trace(), "s", stack(["person", "decision"])).send("oi");
  expect(nobody.outputs[0]).toMatchObject({ status: "failed", error: "no one chose: person: no one to ask here; decision: no decision model yet" });
  const late = await new StackRunner(router, trace(), "s", stack(["model"], "mac/o/chooser-late")).send("oi");
  expect(late.outputs[0]).toMatchObject({ status: "ok", steps: 2, choice: { node: "b" } });
  const never = await new StackRunner(router, trace(), "s", stack(["model"], "mac/o/chooser-never")).send("oi");
  expect(never.outputs[0]).toMatchObject({ status: "failed", error: "no one chose: model: its choice did not come in the shape asked, twice" });
});

test("the person chooses, seeing the answers; not choosing passes it to the next in 'by'", async () => {
  const { router, calls } = fakes();
  const asked: string[] = [];
  const stack = stackOf({ a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, c: { model: "mac/o/chooser", role: "choose", from: ["a", "b"], by: ["person", "model"] } });
  const events: string[] = [];
  const r = await new StackRunner(router, trace(), "s", stack).send("oi", {
    onEvent: (e) => e.type === "asking" && events.push(e.options.map((o) => `${o.label}=${o.node}`).join(" ")),
    ask: async (c) => (asked.push(c.options.map((o) => o.text).join(" | ")), "A"),
  });
  expect(events).toEqual(["A=a B=b"]);
  expect(asked).toEqual(["a: oi | b: oi"]);
  expect(r.outputs[0]).toMatchObject({ text: "a: oi", choice: { node: "a", label: "A", by: "person" } });
  expect(calls.some((c) => c.model === "chooser")).toBe(false);
  const passed = await new StackRunner(router, trace(), "s", stack).send("oi", { ask: async () => undefined });
  expect(passed.outputs[0]!.choice).toMatchObject({ by: "model", passed: ["person: did not choose"] });
});
