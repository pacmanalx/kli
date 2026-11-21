import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeLine } from "../src/cli/output.ts";
import { groundRows } from "../src/cli/stack-view.ts";
import { ground, mask, Sources } from "../src/core/ground.ts";
import type { ChatRequest, Provider } from "../src/core/providers/provider.ts";
import { Router } from "../src/core/router.ts";
import { FilesSourceReader, listFiles } from "../src/core/sources/files.ts";
import { sourceProblems } from "../src/core/sources/index.ts";
import { rank, words } from "../src/core/sources/source.ts";
import { StackRunner } from "../src/core/stack-run.ts";
import { stackOutputs, stackProblems } from "../src/core/stack.ts";
import { Trace } from "../src/core/trace.ts";
import type { Config, SourceConfig, StackConfig } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-ground-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A folder with these files. */
function folder(name: string, files: Record<string, string | Uint8Array>): string {
  const path = join(dir, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
}

const docs = folder("docs", {
  "guia.md": "# Guia\n\nIntro do produto.\n\n## Instalação\n\nRode bun install e depois bun test.\n\n## Reembolso\n\nO reembolso sai em até 7 dias úteis, pelo mesmo meio de pagamento.\n",
  "vendas.csv": "produto,mes,qtd\n" + Array.from({ length: 25 }, (_, i) => `${i === 22 ? "Grace" : `P${i}`},10,${i}`).join("\n") + "\n",
  "itens.json": JSON.stringify([{ nome: "caneta", cor: "azul" }, { nome: "lápis", cor: "preto" }]),
  "node_modules/x/README.md": "reembolso reembolso reembolso",
  "foto.bin": new Uint8Array([0, 1, 2, 0, 80, 81]),
});

test("the words searched: lower case, no accents, no stop words; BM25 puts the piece about the query first", () => {
  expect(words("Quanto vendemos de Grace em outubro?")).toEqual(["quanto", "vendemos", "grace", "outubro"]);
  const [a, b] = rank("reembolso dias", ["o reembolso sai em 7 dias", "a instalação usa bun"]);
  expect(a!.score).toBeGreaterThan(b!.score);
  expect([a!.relevance, b!.relevance]).toEqual([1, 0]);
});

test("files are cut by kind: Markdown by section, CSV in rows with the header, JSON by item; node_modules and binaries left out", async () => {
  expect(listFiles([docs]).map((f) => f.slice(docs.length + 1)).sort()).toEqual(["foto.bin", "guia.md", "itens.json", "vendas.csv"]);
  const source = new FilesSourceReader("docs", { type: "files", paths: [docs] });
  const [first] = await source.search("como funciona o reembolso", 3);
  expect(first).toMatchObject({ source: "docs", title: "guia.md · Reembolso", relevance: 0.5 });
  expect(first!.text).toBe("## Reembolso\n\nO reembolso sai em até 7 dias úteis, pelo mesmo meio de pagamento.");
  expect(first!.ref).toMatch(/guia\.md:9-11$/);
  expect(first!.link).toBe(`file://${join(docs, "guia.md")}`);
  const [rows] = await source.search("Grace", 1);
  expect(rows!.text.split("\n")[0]).toBe("produto,mes,qtd");
  expect(rows!.ref).toMatch(/vendas\.csv:rows 21-25$/);
  const [item] = await source.search("lápis preto", 1);
  expect(item!.title).toBe("itens.json");
  // a glob names the files too
  expect(listFiles([join(docs, "*.md")]).map((f) => f.slice(docs.length + 1))).toEqual(["guia.md"]);
});

test("a long section with no blank line (a list, a code block) is still cut, at about twice the size", async () => {
  const path = folder("long", { "list.md": "# Lista\n" + Array.from({ length: 200 }, (_, i) => `- item ${i} com um texto qualquer`).join("\n") + "\n" });
  const source = new FilesSourceReader("l", { type: "files", paths: [path] });
  const found = await source.search("item texto", 50);
  expect(found.length).toBeGreaterThan(2);
  expect(Math.max(...found.map((f) => f.text.length))).toBeLessThan(2600);
});

test("a file is cut again only when it changed", async () => {
  const path = folder("changing", { "a.md": "# A\n\nprimeira versão do texto\n" });
  const source = new FilesSourceReader("c", { type: "files", paths: [path] });
  expect((await source.search("primeira", 1)).length).toBe(1);
  writeFileSync(join(path, "a.md"), "# A\n\nsegunda versão\n");
  utimesSync(join(path, "a.md"), new Date(), new Date(Date.now() + 5000));
  expect(await source.search("primeira", 1)).toEqual([]);
  expect((await source.search("segunda", 1)).length).toBe(1);
});

test("a grounding node keeps the most relevant excerpts that fit its budget, the attached files first, with what it hides hidden", async () => {
  const sources = new Sources({ docs: { type: "files", paths: [docs] } });
  const g = await ground({ role: "ground", sources: ["docs", "nada"], budget: 50, attach: [join(docs, "guia.md")] }, "reembolso Grace", sources);
  // the attached guide alone takes most of the budget: the excerpts that do not fit are counted
  expect(g.items[0]).toMatchObject({ source: "attached", title: "guia.md" });
  expect(g.cut).toBeGreaterThan(0);
  expect(g.tokens).toBeLessThanOrEqual(50);
  expect(g.sources).toEqual([
    expect.objectContaining({ name: "docs", found: expect.any(Number), kept: g.items.length - 1 }),
    expect.objectContaining({ name: "nada", found: 0, error: "not one of the config's sources" }),
  ]);
  expect(g.mode).toBe("enrich");
  expect(mask("ana@x.com.br, cpf 123.456.789-09, fone (11) 98765-4321", ["email", "cpf", "phone"])).toBe("[email], cpf [cpf], fone [phone]");
});

// ---------- in a stack ----------

const config: Config = { locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "a" } } } } };

/** Fake models: each answers with its name and what it got; "judge" judges A and B. Every call is kept. */
function fakes() {
  const calls: { model: string; request: ChatRequest }[] = [];
  const router = new Router(config, (name, cfg): Provider => ({
    name,
    model: cfg.model,
    async chat(request) {
      calls.push({ model: cfg.model, request: { ...request, messages: [...request.messages] } });
      if (cfg.model === "judge") return { text: '{"requirements": ["r"], "answers": {"A": {"items": ["met"]}, "B": {"items": ["met"]}}}' };
      return { text: `${cfg.model}: o reembolso sai em 7 dias`, inputTokens: 5, outputTokens: 2 };
    },
  }));
  const prompt = (model: string) => calls.find((c) => c.model === model)!.request.messages.at(-1)!.content;
  return { router, calls, prompt };
}
const sourcesConfig: Record<string, SourceConfig> = { docs: { type: "files", paths: [docs] } };
const trace = () => new Trace(join(dir, "sessions"), { user: "test", surface: "test" });

test("a grounding node before a node: the node gets the request and the numbered context, with the rules of the mode", async () => {
  const { router, prompt } = fakes();
  const stack: StackConfig = { nodes: { ctx: { role: "ground", sources: ["docs"], mode: "restrict", rules: "Responda em uma frase." }, a: { model: "mac/o/a", from: ["ctx"] } } };
  const t = trace();
  const r = await new StackRunner(router, t, "s", stack, { sources: sourcesConfig }).send("como funciona o reembolso?");
  const p = prompt("a");
  expect(p).toStartWith("<request>\ncomo funciona o reembolso?\n</request>\n\nContext from data sources:\n\n<context>\n[1] docs · guia.md · Reembolso · ");
  expect(p).toContain("O reembolso sai em até 7 dias úteis");
  expect(p).toContain("<rules>\nAnswer only from the context, citing [n] for each fact you take from it. If what is asked is not in the context, say that it is not there.\nResponda em uma frase.\n</rules>");
  expect(p).not.toContain("Earlier steps answered");
  expect(r.outputs.map((o) => o.node)).toEqual(["a"]);
  const ctx = r.nodes.find((n) => n.node === "ctx")!;
  expect(ctx).toMatchObject({ role: "ground", model: "grounding · docs", status: "ok" });
  expect(nodeLine(ctx, false)).toMatch(/^✓ ctx  grounding · docs · \d+\.\ds · \d+ excerpts? · \d+ tokens/);
  expect(groundRows(r.nodes, 100, false)[1]).toMatch(/^ ◈ ctx · grounding · restrict · \d+ excerpts? · \d+ tokens/);
  // the trace says what went in: each source, each excerpt, and the query as content
  const event = readFileSync(t.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "ground");
  expect(event).toMatchObject({ node: "ctx", stack: "s", content: "como funciona o reembolso?", sources: [{ name: "docs", kept: expect.any(Number) }] });
  expect(event.excerpts[0].ref).toMatch(/guia\.md:9-11$/);
});

test("between two steps a grounding node breaks nothing: the next one gets the answers through it, by letter, and the context", async () => {
  const { router, prompt } = fakes();
  const stack: StackConfig = {
    nodes: {
      a: { model: "mac/o/a" },
      b: { model: "mac/o/b" },
      fatos: { role: "ground", from: ["a", "b"], sources: ["docs"], query: "answers" },
      rev: { model: "mac/o/rev", role: "aggregate", from: ["fatos"] },
    },
  };
  const r = await new StackRunner(router, trace(), "s", stack, { sources: sourcesConfig }).send("diga algo");
  const p = prompt("rev");
  // the query came from the answers ("reembolso … dias"), not from the request ("diga algo")
  expect(p).toContain('<answer from="A">\na: o reembolso sai em 7 dias\n</answer>');
  expect(p).toContain('<answer from="B">\nb: o reembolso sai em 7 dias\n</answer>');
  expect(p).toContain("[1] docs · guia.md · Reembolso");
  expect(r.nodes.find((n) => n.node === "rev")!.contributions).toBeUndefined();
  expect(r.outputs.map((o) => o.node)).toEqual(["rev"]);
});

test("a grounding node before a verifier: the answers it judges are still the stack's, and it judges them against the context", async () => {
  const { router, prompt } = fakes();
  const stack: StackConfig = {
    nodes: {
      a: { model: "mac/o/a" },
      b: { model: "mac/o/b" },
      casa: { role: "ground", from: ["a", "b"], sources: ["docs"], query: "both" },
      juiz: { model: "mac/o/judge", role: "verify", from: ["casa"] },
    },
  };
  expect(stackOutputs(stack)).toEqual(["a", "b"]);
  const r = await new StackRunner(router, trace(), "s", stack, { sources: sourcesConfig }).send("reembolso");
  expect(prompt("judge")).toContain("The answers were given this context from data sources. Judge too whether what they say agrees with it");
  expect(r.nodes.find((n) => n.node === "juiz")!.verdict!.judged.map((j) => j.node)).toEqual(["a", "b"]);
});

test("grounding nodes in a row: the context of both, numbered as one", async () => {
  const { router, prompt } = fakes();
  const stack: StackConfig = {
    nodes: {
      g1: { role: "ground", sources: ["docs"], top: 1 },
      g2: { role: "ground", from: ["g1"], sources: ["docs"], top: 1, query: "both" },
      a: { model: "mac/o/a", from: ["g2"] },
    },
  };
  await new StackRunner(router, trace(), "s", stack, { sources: sourcesConfig }).send("reembolso Grace");
  const p = prompt("a");
  expect(p).toContain("\n[1] docs · ");
  expect(p).toContain("\n[2] docs · ");
});

test("the shape of a grounding node: no model, its sources, a known mode and query, and someone to feed", () => {
  const where = 'stack "s": node "g"';
  expect(stackProblems("s", { nodes: { g: { role: "ground", model: "m", sources: [], mode: "x" as "enrich", query: "answers", budget: 5, top: 0, mask: ["iban" as "email"], tools: "read" }, a: { model: "m", from: ["g"] } } })).toEqual([
    `${where}: a grounding node has no model: it only searches (leave "model" out)`,
    `${where}: to ground, it needs "sources": the names of the config's data sources`,
    `${where}: mode is enrich or restrict`,
    `${where}: to search with the answers, it needs "from" (the nodes whose answers it gets)`,
    `${where}: budget is a number of tokens, from 100 to 200000`,
    `${where}: top is a number from 1 to 100`,
    `${where}: mask is a list of email, cpf, phone`,
    `${where}: a grounding node has no tools`,
  ]);
  expect(stackProblems("s", { nodes: { g: { role: "ground", sources: ["docs"] }, a: { model: "m" } } })).toEqual([
    `${where}: a grounding node feeds the next step: put it in the "from" of the node that uses its context`,
  ]);
  expect(stackProblems("s", { nodes: { a: { model: "m", sources: ["docs"] } } })).toEqual(['stack "s": node "a": "sources" is for a grounding node (role "ground")']);
  expect(sourceProblems({ docs: { type: "files", paths: ["docs/*.md"] }, "x y": { type: "sql" as "files", paths: [] } })).toEqual([
    'source "docs": paths is a list of files, folders or globs, each from / or ~ ("~/docs/**/*.md")',
    'source "x y": use letters, digits, dot, dash or underscore',
    'source "x y": type is files',
  ]);
});

test("a grounding node whose every source fails fails, and the node after it still answers, told why, in the same mode", async () => {
  const { router, calls } = fakes();
  const stack: StackConfig = { nodes: { g: { role: "ground", sources: ["missing"], mode: "restrict" }, a: { model: "mac/o/a", from: ["g"] } } };
  const r = await new StackRunner(router, trace(), "s", stack, { sources: sourcesConfig }).send("x");
  expect(r.nodes.map((n) => [n.node, n.status, n.error])).toEqual([
    ["g", "failed", "missing: not one of the config's sources"],
    ["a", "ok", undefined],
  ]);
  // a stack does not stop (12/11/2026); in restrict, it still answers only from the sources, so it says they failed
  const got = calls.find((c) => c.model === "a")!.request.messages.at(-1)!.content;
  expect(got).toContain("(the data sources could not be searched: missing: not one of the config's sources)");
  expect(got).toContain("Answer only from the context");
});
