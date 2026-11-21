import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGround, addNode, cleanNode, cleanStack, connect, disconnect, layout, outputsOf, removeNode, renameNode, updateNode } from "../src/cli/stackbuilder/graph.ts";
import { startBuilder, type Builder } from "../src/cli/stackbuilder/server.ts";
import { putSource, putStack, removeSource, removeStack } from "../src/core/config.ts";
import { Core, loadConfig } from "../src/core/index.ts";
import type { ProviderFactory } from "../src/core/providers/index.ts";
import type { Config, StackConfig } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-builder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const two: StackConfig = { nodes: { a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, j: { model: "mac/o/a", from: ["a", "b"] } } };

// ---------- the graph's edits ----------

test("the layout puts the nodes that get the prompt in the first column and each join after its inputs", () => {
  const at = layout({ nodes: { ...two.nodes, v: { model: "m", role: "verify", from: ["j"] } } });
  expect(at.a!.x).toBe(at.b!.x);
  expect(at.j!.x).toBeGreaterThan(at.a!.x);
  expect(at.v!.x).toBeGreaterThan(at.j!.x);
  expect(at.a!.y).not.toBe(at.b!.y);
  // a circle still gets places (the page shows the problem)
  expect(Object.keys(layout({ nodes: { x: { model: "m", from: ["y"] }, y: { model: "m", from: ["x"] } } }))).toEqual(["x", "y"]);
});

test("connecting adds the input, and a self or circular connection is refused", () => {
  const s = connect({ nodes: { a: { model: "m" }, b: { model: "m" } } }, "a", "b");
  expect(s.nodes.b!.from).toEqual(["a"]);
  expect(connect(s, "a", "b")).toBe(s);
  expect(() => connect(s, "b", "a")).toThrow(/circle/);
  expect(() => connect(s, "a", "a")).toThrow(/own answer/);
  expect(() => connect(two, "a", "x")).toThrow(/nodes/);
});

test("disconnecting the last input makes the node get the prompt again, and a min it no longer reaches goes", () => {
  const s = updateNode(two, "j", { min: 2 });
  expect(s.nodes.j!.min).toBe(2);
  const one = disconnect(s, "a", "j");
  expect(one.nodes.j).toEqual({ model: "mac/o/a", from: ["b"] });
  expect(disconnect(one, "b", "j").nodes.j).toEqual({ model: "mac/o/a" });
});

test("removing a node takes it out of the inputs of the others", () => {
  expect(removeNode(two, "a").nodes).toEqual({ b: { model: "mac/o/b" }, j: { model: "mac/o/a", from: ["b"] } });
});

test("renaming keeps the node's place and the inputs follow; a bad or taken name is refused", () => {
  const s = renameNode(two, "a", "first");
  expect(Object.keys(s.nodes)).toEqual(["first", "b", "j"]);
  expect(s.nodes.j!.from).toEqual(["first", "b"]);
  expect(() => renameNode(two, "a", "b")).toThrow(/already/);
  expect(() => renameNode(two, "a", "x y")).toThrow(/letters/);
});

test("a new node gets a free name and the model it is given", () => {
  const { stack, id } = addNode(addNode(two, "m").stack, "n");
  expect(id).toBe("node2");
  expect(stack.nodes.node2).toEqual({ model: "n" });
});

test("a node is saved without the fields that say nothing", () => {
  expect(cleanNode({ model: "m", role: "answer", from: [], by: ["model"], instructions: " ", fallback: [], output: false, min: 1 })).toEqual({ model: "m" });
  expect(cleanNode({ model: "m", role: "choose", by: ["person"], from: ["a", "b"], min: 2 })).toEqual({ model: "m", role: "choose", by: ["person"], from: ["a", "b"], min: 2 });
  expect(updateNode(two, "j", { role: "aggregate", tools: undefined }).nodes.j).toEqual({ model: "mac/o/a", role: "aggregate", from: ["a", "b"] });
  expect(cleanStack({ description: "  ", nodes: { a: { model: "m", role: "answer" } } })).toEqual({ nodes: { a: { model: "m" } } });
  // the purpose the triage reads is kept, trimmed; a blank one goes away
  expect(cleanStack({ purpose: " fixing code ", nodes: { a: { model: "m" } } })).toEqual({ purpose: "fixing code", nodes: { a: { model: "m" } } });
  expect(cleanStack({ purpose: " ", nodes: { a: { model: "m" } } })).toEqual({ nodes: { a: { model: "m" } } });
  // a verifier's own requirements, without the blank lines; any other node has none
  expect(cleanNode({ model: "m", role: "verify", from: ["a"], requirements: [" cites the file ", ""] })).toEqual({ model: "m", role: "verify", from: ["a"], requirements: ["cites the file"] });
  expect(cleanNode({ model: "m", requirements: ["x"] })).toEqual({ model: "m" });
  // the fence, off or with the network, is kept
  expect(cleanStack({ nodes: { a: { model: "m", tools: "write" } }, write: { setup: " ", fence: false } }).write).toEqual({ fence: false });
  expect(outputsOf(two)).toEqual(["j"]);
});

// ---------- the config ----------

const config: Config = {
  locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "a" } } } },
  model: "mac/o/a",
  stacks: { compara: { nodes: { x: { model: "mac/o/a" } } }, outra: { nodes: { y: { model: "mac/o/b" } } } },
  stack: "compara",
};

test("a stack is added or replaced in its place; renaming the one answering keeps it answering", () => {
  expect(Object.keys(putStack(config, "nova", two).stacks!)).toEqual(["compara", "outra", "nova"]);
  const renamed = putStack(config, "comparar", { nodes: { x: { model: "mac/o/a" }, z: { model: "mac/o/a" } } }, "compara");
  expect(Object.keys(renamed.stacks!)).toEqual(["comparar", "outra"]);
  expect(renamed.stack).toBe("comparar");
  expect(() => putStack(config, "outra", two, "compara")).toThrow(/already exists/);
  expect(() => putStack(config, "ruim", { nodes: { x: { model: "m", from: ["nada"] } } })).toThrow(/not a node/);
});

test("deleting the stack that answers lets the model answer again", () => {
  const next = removeStack(config, "compara");
  expect(next.stack).toBeUndefined();
  expect(Object.keys(next.stacks!)).toEqual(["outra"]);
  expect(removeStack(next, "outra").stacks).toBeUndefined();
  expect(() => removeStack(config, "nada")).toThrow(/not one of the stacks/);
});

// ---------- the page's server ----------

const path = join(dir, "config.json");
writeFileSync(path, JSON.stringify({ ...config, sessions: { dir: join(dir, "sessions") } }, null, 2));
/** Fake models: each says who it is; "chooser" picks B. */
const factory: ProviderFactory = (name, cfg) => ({
  name,
  model: cfg.model,
  async chat(request) {
    const text = cfg.model === "chooser" ? '{"choice": "B", "why": "melhor"}' : `${cfg.model} respondeu`;
    request.onDelta?.(text);
    return { text, inputTokens: 3, outputTokens: 4 };
  },
});
const core = new Core(loadConfig(path), path, factory);
const changes: unknown[] = [];
let builder: Builder;
let token = "";
beforeAll(() => {
  builder = startBuilder(core, { root: dir, onChange: (c) => changes.push(c) });
  token = new URL(builder.url).searchParams.get("t")!;
});
afterAll(() => builder.stop());

const call = (to: string, init: RequestInit = {}) => fetch(new URL(to, builder.url), { ...init, headers: { "content-type": "application/json", "x-kli-token": token, ...init.headers } });
const saved = () => JSON.parse(readFileSync(path, "utf8")) as Config;
/** The lines a run streamed, as they came. */
async function lines(r: Response, onLine?: (e: { type: string; [k: string]: unknown }) => void): Promise<{ type: string; [k: string]: unknown }[]> {
  const out: { type: string; [k: string]: unknown }[] = [];
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const e = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      out.push(e);
      onLine?.(e);
    }
  }
  return out;
}

test("the page opens on this machine, and the API answers only with the page's key", async () => {
  expect(builder.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  const page = await fetch(builder.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<div id="root">');
  expect((await fetch(new URL("/api/state", builder.url))).status).toBe(403);
  expect((await call("/api/state", { headers: { "x-kli-token": "other" } })).status).toBe(403);
});

test("the state brings the stacks, the one answering and the models to offer", async () => {
  const s = (await (await call("/api/state")).json()) as { stacks: Record<string, unknown>; active: string; refs: string[]; sources: string[]; problems: Record<string, string[]> };
  expect(Object.keys(s.stacks)).toEqual(["compara", "outra"]);
  expect(s.active).toBe("compara");
  expect(s.refs).toEqual(["mac/o/a", "mac/o/b"]);
  expect(s.sources).toEqual(["mac/o"]);
  expect(s.problems).toEqual({ compara: [], outra: [] });
});

test("checking a stack gives its shape problems, then the models the config does not have", async () => {
  const check = async (stack: StackConfig, name = "nova") => ((await (await call("/api/check", { method: "POST", body: JSON.stringify({ name, stack }) })).json()) as { problems: string[] }).problems;
  expect(await check(two)).toEqual([]);
  expect((await check({ nodes: { a: { model: "longe/x/y" } } }))[0]).toMatch(/node "a": .*longe/);
  expect((await check({ nodes: { a: { model: "mac/o/a", from: ["b"] }, b: { model: "mac/o/a", from: ["a"] } } })).join()).toMatch(/no node gets the prompt/);
  expect((await check(two, "x y"))[0]).toMatch(/use letters/);
});

test("saving writes the stack to the config file; renaming the one answering keeps it answering", async () => {
  let r = await call("/api/stacks/nova", { method: "PUT", body: JSON.stringify({ stack: { nodes: { a: { model: "mac/o/a", role: "answer", from: [] } } } }) });
  expect(r.status).toBe(200);
  expect(saved().stacks!.nova).toEqual({ nodes: { a: { model: "mac/o/a" } } });
  r = await call("/api/stacks/comparar", { method: "PUT", body: JSON.stringify({ stack: two, previous: "compara" }) });
  expect(r.status).toBe(200);
  expect(Object.keys(saved().stacks!)).toEqual(["comparar", "outra", "nova"]);
  expect(saved().stack).toBe("comparar");
  expect(core.config.stack).toBe("comparar");
  expect(changes).toContainEqual({ saved: "comparar", previous: "compara" });
  r = await call("/api/stacks/ruim", { method: "PUT", body: JSON.stringify({ stack: { nodes: { a: { model: "m", from: ["z"] } } } }) });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toMatch(/not a node/);
});

test("choosing the stack that answers, and deleting it, go to the config", async () => {
  await call("/api/active", { method: "PUT", body: JSON.stringify({ name: "nova" }) });
  expect(saved().stack).toBe("nova");
  const r = await call("/api/stacks/nova", { method: "DELETE" });
  expect(r.status).toBe(200);
  expect(saved().stacks!.nova).toBeUndefined();
  expect(saved().stack).toBeUndefined();
  expect(changes).toContainEqual({ active: "nova" });
  expect(changes).toContainEqual({ deleted: "nova" });
});

test("testing runs the stack as it is on the page, saved or not, and streams what each node does", async () => {
  const r = await call("/api/run", { method: "POST", body: JSON.stringify({ name: "rascunho", stack: two, prompt: "oi" }) });
  expect(r.headers.get("content-type")).toContain("ndjson");
  const events = await lines(r);
  expect(events[0]!.type).toBe("run");
  expect(events.filter((e) => e.type === "start").map((e) => e.node)).toEqual(["a", "b", "j"]);
  expect(events.some((e) => e.type === "delta" && e.node === "b" && e.text === "b respondeu")).toBe(true);
  const result = events.at(-1)!;
  expect(result.type).toBe("result");
  expect((result.result as { outputs: { node: string; text: string }[] }).outputs.map((o) => o.node)).toEqual(["j"]);
  // a test leaves a trace like any session, marked as the builder's
  const traces = readdirSync(join(dir, "sessions"));
  expect(traces.length).toBe(1);
  expect(readFileSync(join(dir, "sessions", traces[0]!), "utf8")).toContain('"surface":"builder"');
});

test("a node that the person chooses waits for the page, and the choice comes back by its run", async () => {
  const stack: StackConfig = { nodes: { a: { model: "mac/o/a" }, b: { model: "mac/o/b" }, c: { model: "mac/o/a", role: "choose", by: ["person", "model"], from: ["a", "b"] } } };
  const r = await call("/api/run", { method: "POST", body: JSON.stringify({ name: "escolhe", stack, prompt: "oi" }) });
  let run = "";
  const events = await lines(r, (e) => {
    if (e.type === "run") run = e.id as string;
    if (e.type === "choose") {
      expect((e.options as { label: string; text: string }[]).map((o) => [o.label, o.text])).toEqual([["A", "a respondeu"], ["B", "b respondeu"]]);
      void call("/api/choose", { method: "POST", body: JSON.stringify({ run, label: "B" }) });
    }
  });
  const c = (events.at(-1)!.result as { nodes: { node: string; text: string; choice?: { by: string; node: string } }[] }).nodes.find((n) => n.node === "c")!;
  expect(c.choice).toMatchObject({ by: "person", node: "b" });
  expect(c.text).toBe("b respondeu");
  expect((await call("/api/choose", { method: "POST", body: JSON.stringify({ run, label: "A" }) })).status).toBe(404);
});

test("a grounding node is saved without a model, without its defaults, and nothing of a model's", () => {
  const { stack, id } = addGround({ nodes: { a: { model: "m", from: [] } } }, ["docs"]);
  expect(id).toBe("context");
  expect(stack.nodes.context).toEqual({ role: "ground", sources: ["docs"] });
  expect(cleanNode({ role: "ground", model: "m", sources: ["docs"], mode: "enrich", query: "request", rules: " ", attach: [" ", "~/g.md"], mask: [], tools: "read", instructions: "x", fallback: ["y"] })).toEqual({ role: "ground", sources: ["docs"], attach: ["~/g.md"] });
  // leaving the role, what only a grounding node has goes away
  expect(cleanNode({ model: "m", sources: ["docs"], mode: "restrict", budget: 500 })).toEqual({ model: "m" });
});

test("a data source is added, renamed with the grounding nodes that search it, and kept while one does", () => {
  const withSource = putSource({ ...config, stack: undefined, stacks: { b: { nodes: { g: { role: "ground", sources: ["docs"] }, a: { model: "mac/o/a", from: ["g"] } } } } }, "docs", { type: "files", paths: ["~/docs"] });
  const renamed = putSource(withSource, "manuais", { type: "files", paths: ["~/docs"] }, "docs");
  expect(Object.keys(renamed.sources!)).toEqual(["manuais"]);
  expect(renamed.stacks!.b!.nodes.g!.sources).toEqual(["manuais"]);
  expect(() => removeSource(renamed, "manuais")).toThrow('source "manuais" is searched by b/g: take it out of them first');
  expect(() => putSource(config, "x", { type: "files", paths: ["docs"] })).toThrow(/each from \/ or ~/);
});

test("the page saves a data source, tries a search in it before saving, and says what a stack's grounding nodes lack", async () => {
  const docs = join(dir, "docs-src");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "guia.md"), "# Guia\n\n## Reembolso\n\nO reembolso sai em 7 dias.\n");
  const tried = (await (await call("/api/source-test", { method: "POST", body: JSON.stringify({ source: { type: "files", paths: [docs] }, query: "reembolso" }) })).json()) as { excerpts: { ref: string }[] };
  expect(tried.excerpts[0]!.ref).toMatch(/guia\.md:3-5$/);
  expect((await call("/api/source-test", { method: "POST", body: JSON.stringify({ source: { type: "files", paths: [docs] }, query: " " }) })).status).toBe(400);
  const state = (await (await call("/api/sources/docs", { method: "PUT", body: JSON.stringify({ source: { type: "files", paths: [docs] } }) })).json()) as { dataSources: Record<string, unknown> };
  expect(Object.keys(state.dataSources)).toEqual(["docs"]);
  expect(saved().sources).toEqual({ docs: { type: "files", paths: [docs] } });
  const check = (await (await call("/api/check", { method: "POST", body: JSON.stringify({ name: "b", stack: { nodes: { g: { role: "ground", sources: ["docs", "nada"] }, a: { model: "mac/o/a", from: ["g"] } } } }) })).json()) as { problems: string[] };
  expect(check.problems).toEqual(['node "g": "nada" is not one of the config\'s sources']);
  // a test run shows what the grounding node handed on
  const r = await call("/api/run", { method: "POST", body: JSON.stringify({ stack: { nodes: { g: { role: "ground", sources: ["docs"] }, a: { model: "mac/o/a", from: ["g"] } } }, prompt: "e o reembolso?" }) });
  const events = await lines(r);
  const g = events.find((e) => e.type === "end" && e.node === "g")!.result as { grounding: { items: { ref: string }[] } };
  expect(g.grounding.items[0]!.ref).toMatch(/guia\.md:3-5$/);
  expect((await call("/api/sources/docs", { method: "DELETE" })).status).toBe(200);
  expect(saved().sources).toBeUndefined();
});

test("a test without a prompt, or with a broken stack, is refused before running", async () => {
  expect((await call("/api/run", { method: "POST", body: JSON.stringify({ stack: two, prompt: " " }) })).status).toBe(400);
  const r = await call("/api/run", { method: "POST", body: JSON.stringify({ stack: { nodes: { a: { model: "m", from: ["a"] } } }, prompt: "oi" }) });
  expect(r.status).toBe(400);
});

test("the compiled kli serves the page with the production JSX (the development one breaks it)", async () => {
  // only `bun build --compile` shows it: with React in production, a page compiled with jsxDEV never mounts
  const bin = join(dir, "kli");
  const build = Bun.spawnSync([process.execPath, "run", "build", "--", "--outfile", bin], { cwd: join(import.meta.dir, ".."), stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  writeFileSync(join(dir, "open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const server = Bun.spawn([bin, "stackbuilder"], { cwd: dir, env: { ...process.env, KLI_CONFIG: path, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  try {
    const reader = server.stdout.getReader();
    let printed = "";
    while (!/http:\/\/\S+/.test(printed)) printed += new TextDecoder().decode((await reader.read()).value);
    const url = printed.match(/http:\/\/\S+/)![0];
    const script = (await (await fetch(url)).text()).match(/src="([^"]+\.js)"/)![1]!;
    const js = await (await fetch(new URL(script, url))).text();
    // compared as flags: a failure must not print the whole bundle
    expect({ reactFlow: js.includes("react-flow"), developmentJsx: js.includes("jsxDEV") }).toEqual({ reactFlow: true, developmentJsx: false });
  } finally {
    server.kill();
  }
}, 60_000);
