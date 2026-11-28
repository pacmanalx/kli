import { expect, test } from "bun:test";
import { applyStackEvent, comparisonRows, stackRows, stackView, verdictRows } from "../src/cli/stack-view.ts";
import type { NodeResult } from "../src/core/stack-run.ts";
import type { StackConfig } from "../src/core/types.ts";

const compare: StackConfig = { nodes: { gpubox: { model: "gpubox/ollama/lfm3" }, desk: { model: "desk/llama.cpp/qwen2.5-7b" } } };
const review: StackConfig = { nodes: { a: { model: "m/a" }, b: { model: "m/b" }, junta: { model: "m/j", from: ["a", "b"] } } };
const done = (node: string, model: string, text: string, extra: Partial<NodeResult> = {}): NodeResult => ({
  node,
  role: "answer",
  model,
  answeredBy: model,
  status: "ok",
  text,
  ms: 6300,
  firstTokenMs: 4800,
  inputTokens: 2080,
  outputTokens: 82,
  tokensPerSecond: 53.2,
  steps: 2,
  tools: [{ name: "Glob", label: "Glob(*)", ok: true }],
  ...extra,
});

test("the tree fills in as the nodes work: waiting, at work, done", () => {
  const view = stackView("revisao", review, 0);
  expect(view.outputs).toEqual(["junta"]);
  applyStackEvent(view, { type: "start", node: "a", model: "m/a" }, 0);
  applyStackEvent(view, { type: "tool", node: "a", event: { phase: "start", call: { id: "1", name: "Bash", input: {} }, label: "Bash(ls)" } }, 0);
  const rows = stackRows(view, 100, 3200, false);
  expect(rows[0]).toBe(" ◆ stack revisao · 3.2s · 0 of 3 done");
  expect(rows[1]).toMatch(/^ ├ [◐◓◑◒] a  m\/a · 3\.2s · 1 tool · Bash\(ls\)$/);
  expect(rows[2]).toBe(" ├ · b  m/b");
  expect(rows[3]).toBe(" └ · junta  m/j · waits for a, b");
  applyStackEvent(view, { type: "delta", node: "a", text: "parcial" }, 0);
  expect(view.nodes[0]).toMatchObject({ text: "parcial", doing: "answering" });
  applyStackEvent(view, { type: "end", node: "a", result: done("a", "m/a", "final") }, 0);
  expect(stackRows(view, 100, 7000, false)[1]).toBe(" ├ ✓ a  m/a · 6.3s · first token 4.8s · 2080→82 tokens · 53.2 tok/s · 1 tool");
});

test("between tools a node shows how many it used and the last one, not a plain wait", () => {
  const view = stackView("compara", compare, 0);
  applyStackEvent(view, { type: "start", node: "gpubox", model: "gpubox/ollama/lfm3" }, 0);
  // a CLI agent's Read starts and ends at once (agy): what stays in sight is that it was done
  for (const [id, label] of [["1", "Read(a.cs)"], ["2", "Edit(a.cs)"]] as const) {
    applyStackEvent(view, { type: "tool", node: "gpubox", event: { phase: "start", call: { id, name: "x", input: {} }, label } }, 0);
    applyStackEvent(view, { type: "tool", node: "gpubox", event: { phase: "output", call: { id, name: "x", input: {} }, label, output: "…" } }, 0);
    applyStackEvent(view, { type: "tool", node: "gpubox", event: { phase: "end", call: { id, name: "x", input: {} }, label, result: { ok: true, output: "", summary: "" } } }, 0);
  }
  expect(stackRows(view, 120, 30_000, false)[1]).toMatch(/gpubox  gpubox\/ollama\/lfm3 · 30s · 2 tools · last Edit\(a\.cs\)$/);
  // long after its last step, with nothing running, it is said to be quiet
  expect(stackRows(view, 120, 400_000, false)[1]).toMatch(/gpubox  gpubox\/ollama\/lfm3 · 6m ?40s · 2 tools · quiet for 6m ?40s · last Edit\(a\.cs\)$/);
});

test("while it runs, a node's line says how it goes: what it read, its first edit, and how long it has been quiet", () => {
  const stack: StackConfig = { nodes: { agy: { model: "mac/agy", tools: "write" }, leitor: { model: "m/l" }, juiz: { model: "m/j", role: "verify", from: ["agy", "leitor"] } } };
  const view = stackView("programa", stack, 0);
  const tool = (node: string, id: string, name: string, label: string, at: number, result?: { ok: boolean; summary: string; output?: string }) => {
    applyStackEvent(view, { type: "tool", node, event: { phase: "start", call: { id, name, input: {} }, label } }, at);
    if (result) applyStackEvent(view, { type: "tool", node, event: { phase: "end", call: { id, name, input: {} }, label, result: { output: "", ...result } } }, at);
  };
  const line = (now: number, i = 0) => stackRows(view, 160, now, false)[i + 1]!;
  for (const n of ["agy", "leitor", "juiz"]) applyStackEvent(view, { type: "start", node: n, model: n }, 0);
  // its copy is Kli's time, not the node being quiet; the model's time starts when it is made
  applyStackEvent(view, { type: "doing", node: "agy", what: "making its copy of the folder" }, 0);
  expect(line(90_000)).not.toContain("quiet");
  applyStackEvent(view, { type: "doing", node: "agy", what: "waiting for the model" }, 90_000);
  // reads as each CLI says them (agy: "Read 17 lines"; Kli's Read: "Read 50 lines of 4006"; a failed one counts nothing)
  tool("agy", "1", "Read", "Read(main.rs)", 100_000, { ok: true, summary: "Read 4006 lines" });
  tool("agy", "2", "Read", "Read(a.docx)", 110_000, { ok: true, summary: "Read 50 lines of 900" });
  tool("agy", "3", "Read", "Read(x)", 115_000, { ok: false, summary: "not found" });
  expect(line(120_000)).toContain(" · 2m 0s · 3 tools · read 4.1k lines · no edit yet · last Read(x)");
  // a command that runs long is not being quiet
  tool("agy", "4", "Bash", "Bash(git log -p)", 130_000);
  expect(line(400_000)).not.toContain("quiet");
  applyStackEvent(view, { type: "tool", node: "agy", event: { phase: "end", call: { id: "4", name: "Bash", input: {} }, label: "Bash(git log -p)", result: { ok: true, output: "", summary: "9000 lines" } } }, 200_000);
  tool("agy", "5", "Edit", "Edit(csv.py)", 232_000, { ok: true, summary: "Updated csv.py: +3 −1" });
  // then 4.4 minutes with no tool and no text
  expect(line(496_000)).toContain(" · 8m 16s · 5 tools · read 4.1k lines · first edit at 3m 52s · quiet for 4m 24s · last Edit(csv.py)");
  // text counts as a step
  applyStackEvent(view, { type: "delta", node: "agy", text: "Pronto." }, 497_000);
  expect(line(500_000)).not.toContain("quiet");
  // a node that only reads has no edit to wait for; one that judges waits for the others, and is never quiet
  tool("leitor", "1", "Read", "Read(a)", 1_000, { ok: true, summary: "12 lines" });
  expect(line(10_000, 1)).toContain(" · 10s · 1 tool · read 12 lines · last Read(a)");
  expect(line(500_000, 2)).not.toContain("quiet");
});

test("while it runs, the tree stays in sight: each answer shows its last lines in the room left", () => {
  const view = stackView("compara", compare, 0);
  for (const n of ["gpubox", "desk"]) applyStackEvent(view, { type: "start", node: n, model: n }, 0);
  const long = Array.from({ length: 80 }, (_, i) => `linha ${i + 1}`).join("\n");
  applyStackEvent(view, { type: "delta", node: "gpubox", text: long }, 0);
  applyStackEvent(view, { type: "delta", node: "desk", text: "curta e parada" }, 0);
  const rows = stackRows(view, 120, 1000, false, 20);
  expect(rows.length).toBeLessThanOrEqual(20);
  // the tree first, as without a room
  expect(rows[1]).toContain("gpubox");
  expect(rows[2]).toContain("desk");
  // the long one shows its end, saying how much came before; the short one is still there, next to it
  const body = rows.join("\n");
  expect(body).toContain("linha 80");
  expect(body).not.toMatch(/ linha 1 +│/);
  expect(body).toMatch(/↑ \d+ lines above/);
  expect(body).toContain("curta e parada");
  // without a room (the scrollback, once it ends), the whole answer
  const whole = stackRows(view, 120, 1000, false);
  expect(whole.join("\n")).toMatch(/ linha 1 +│ curta e parada/);
  expect(whole.length).toBeGreaterThan(80);
  // one answer alone: the same
  const one = stackView("um", { nodes: { a: { model: "m/a" } } }, 0);
  applyStackEvent(one, { type: "start", node: "a", model: "m/a" }, 0);
  applyStackEvent(one, { type: "delta", node: "a", text: long }, 0);
  const single = stackRows(one, 120, 1000, false, 15);
  expect(single.length).toBeLessThanOrEqual(15);
  expect(single[1]).toContain("a  m/a");
  expect(single.at(-1)).toContain("linha 80");
});

test("the answers on the way to the stack's show as they come, side by side, and the stack's goes under them", () => {
  // three that answer, an aggregator that gives the answer, a judge (the personagem of 07/11/2026)
  const stack: StackConfig = {
    nodes: { a: { model: "m/a" }, b: { model: "m/b" }, c: { model: "m/c" }, junta: { model: "m/j", role: "aggregate", from: ["a", "b", "c"] }, v: { model: "m/v", role: "verify", from: ["junta"] } },
  };
  const view = stackView("personagem", stack, 0);
  expect(view.outputs).toEqual(["junta"]);
  const long = (who: string) => Array.from({ length: 80 }, (_, i) => `${who} ${i + 1}`).join("\n");
  for (const n of ["a", "b", "c"]) applyStackEvent(view, { type: "start", node: n, model: `m/${n}` }, 0);
  applyStackEvent(view, { type: "delta", node: "a", text: "Elrond é um meio-elfo." }, 0);
  // a, b and c next to each other while they write; the aggregator still waits, and takes no room
  let rows = stackRows(view, 120, 1000, false, 30);
  const titles = rows.findIndex((r) => r.startsWith(" a · m/a"));
  expect(rows[titles]).toMatch(/^ a · m\/a +│ b · m\/b +│ c · m\/c$/);
  expect(rows[titles + 1]).toMatch(/^ Elrond é um meio-elfo\. +│ … +│ …$/);
  expect(rows.join("\n")).not.toContain("junta · m/j");
  // the judge writes no answer of its own
  expect(rows.join("\n")).not.toContain("v · m/v");
  // long answers: their last lines, with the tree in sight
  for (const n of ["a", "b", "c"]) applyStackEvent(view, { type: "end", node: n, result: done(n, `m/${n}`, long(n)) }, 0);
  rows = stackRows(view, 120, 1000, false, 20);
  expect(rows.length).toBeLessThanOrEqual(20);
  expect(rows[1]).toContain("a  m/a");
  expect(rows.join("\n")).toContain("c 80");
  // the aggregator writes: the others keep their last lines above, and it comes under its heading with most of the room
  applyStackEvent(view, { type: "start", node: "junta", model: "m/j" }, 0);
  applyStackEvent(view, { type: "delta", node: "junta", text: long("junta") }, 0);
  rows = stackRows(view, 120, 1000, false, 30);
  expect(rows.length).toBeLessThanOrEqual(30);
  expect(rows[1]).toContain("a  m/a");
  const heading = rows.indexOf(" ── junta · m/j ──");
  expect(heading).toBeGreaterThan(rows.findIndex((r) => r.startsWith(" a · m/a")));
  expect(rows.at(-1)).toBe(" junta 80");
  expect(rows.slice(heading).filter((r) => /^ junta \d+$/.test(r)).length).toBeGreaterThan(rows.slice(0, heading).filter((r) => /a \d+ +│/.test(r)).length);
  // too narrow for three columns: one under the other, within the room too
  const narrow = stackRows(view, 80, 1000, false, 30);
  expect(narrow.length).toBeLessThanOrEqual(30);
  expect(narrow.filter((r) => r.startsWith(" ── "))).toEqual([" ── a · m/a ──", " ── b · m/b ──", " ── c · m/c ──", " ── junta · m/j ──"]);
  // once done (no room: the scrollback), every answer whole
  applyStackEvent(view, { type: "end", node: "junta", result: { ...done("junta", "m/j", long("junta")), role: "aggregate" } }, 0);
  const whole = stackRows(view, 120, 1000, false).join("\n");
  for (const n of ["a", "b", "c"]) expect(whole).toMatch(new RegExp(`${n} 1( +│|$)`, "m"));
  expect(whole).toMatch(/^ junta 1$/m);
  expect(whole).toMatch(/^ junta 80$/m);
});

test("one answer reads like the model's; two go side by side, each under its node and model", () => {
  const one = stackView("revisao", review, 0);
  applyStackEvent(one, { type: "delta", node: "junta", text: "A resposta juntada." }, 0);
  expect(stackRows(one, 80, 0, false).slice(-1)).toEqual([" A resposta juntada."]);

  const two = stackView("compara", compare, 0);
  applyStackEvent(two, { type: "delta", node: "gpubox", text: "25% de 80 é 20." }, 0);
  const rows = stackRows(two, 100, 0, false);
  const title = rows.findIndex((r) => r.includes("gpubox · gpubox/ollama/lfm3"));
  expect(rows[title]).toMatch(/^ gpubox · gpubox\/ollama\/lfm3 +│ desk · desk\/llama\.cpp\/qwen2\.5-7b$/);
  // the one still waiting shows it is on its way
  expect(rows[title + 1]).toMatch(/^ 25% de 80 é 20\. +│ …$/);
  expect(rows[title]!.indexOf("│")).toBe(rows[title + 1]!.indexOf("│"));
});

test("too narrow for columns: one answer under the other", () => {
  const two = stackView("compara", compare, 0);
  applyStackEvent(two, { type: "end", node: "desk", result: done("desk", "desk/llama.cpp/qwen2.5-7b", "6") }, 0);
  const rows = stackRows(two, 50, 0, false);
  expect(rows.filter((r) => r.startsWith(" ── "))).toEqual([" ── gpubox · gpubox/ollama/lfm3 ──", " ── desk · desk/llama.cpp/qwen2.5-7b ──"]);
  expect(rows.at(-1)).toBe(" 6");
});

test("once done, a table compares the answers: time, first text, tokens, speed, tools, steps", () => {
  const a = done("gpubox", "gpubox/ollama/lfm3", "20");
  const b = done("desk", "desk/llama.cpp/qwen2.5-7b", "6", { ms: 18_500, firstTokenMs: 17_500, tools: [{ name: "Bash", label: "Bash(ls)", ok: true }, { name: "Bash", label: "Bash(x)", ok: false }] });
  expect(comparisonRows([a, b], 100, false)).toEqual([
    "              gpubox       desk",
    " status       ✓ answered   ✓ answered",
    " time         6.3s         18.5s",
    " first text   4.8s         17.5s",
    " tokens       2080→82      2080→82",
    " tok/s        53.2         53.2",
    " tools        Glob         Bash ×2 (1 failed)",
    " steps        2            2",
  ]);
  const view = stackView("compara", compare, 0);
  for (const r of [a, b]) applyStackEvent(view, { type: "end", node: r.node, result: r }, 0);
  view.result = { name: "compara", ms: 18_500, nodeMs: 24_800, nodes: [a, b], outputs: [a, b], inputTokens: 4160, outputTokens: 164 };
  const rows = stackRows(view, 100, 0, false);
  expect(rows[0]).toBe(" ◆ stack compara · 18.5s · 2 of 2 nodes answered · 4160→164 tokens · side by side saved 6.3s");
  expect(rows.at(-1)).toBe(" steps        2            2");
});

test("an answer that did not come says why, in its place", () => {
  const view = stackView("compara", compare, 0);
  applyStackEvent(view, { type: "end", node: "desk", result: { ...done("desk", "desk/llama.cpp/qwen2.5-7b", ""), status: "failed", error: "desk/llama.cpp: cannot connect" } }, 0);
  const rows = stackRows(view, 100, 0, false);
  expect(rows.some((r) => r.includes("│ ✕ desk/llama.cpp: cannot connect"))).toBe(true);
});

test("why a node failed or was skipped is under it in the tree, whole: the screen no longer cuts it off", () => {
  const plan: StackConfig = { nodes: { gemini: { model: "mac/agy/gemini-4-argon-high" }, valida: { model: "m/v", role: "verify", from: ["gemini"] } } };
  const view = stackView("planejamento", plan, 0);
  const error = "mac/agy: stopped at a refused permission (McpTool): agy ends the run there";
  applyStackEvent(view, { type: "end", node: "gemini", result: { ...done("gemini", "mac/agy/gemini-4-argon-high", "Vou ler."), status: "failed", error, ms: 39200 } }, 0);
  applyStackEvent(view, { type: "end", node: "valida", result: { node: "valida", role: "verify", model: "m/v", status: "skipped", text: "", ms: 0, steps: 0, tools: [], error: "0 of 1 inputs answered (gemini did not)" } }, 0);
  const rows = stackRows(view, 60, 0, false);
  // the line says it failed and what it did; the reason, on lines of its own, wraps instead of being cut
  expect(rows[1]).toStartWith(" ├ ✕ gemini  mac/agy/gemini-4-argon-high · failed · 39.2s");
  expect(rows.slice(2, 4)).toEqual([" │   mac/agy: stopped at a refused permission (McpTool):", " │   agy ends the run there"]);
  expect(rows[4]).toBe(" └ – valida  m/v · skipped");
  expect(rows[5]).toBe("     skipped: 0 of 1 inputs answered (gemini did not)");
});

test("an answer cut short keeps what had come, with the mark under it", () => {
  const view = stackView("compara", compare, 0);
  applyStackEvent(view, { type: "delta", node: "gpubox", text: "O computador nasceu" }, 0);
  applyStackEvent(view, { type: "end", node: "gpubox", result: { ...done("gpubox", "gpubox/ollama/lfm3", ""), status: "interrupted" } }, 0);
  const rows = stackRows(view, 100, 0, false);
  const at = rows.findIndex((r) => r.startsWith(" O computador nasceu"));
  expect(rows[at + 1]).toMatch(/^ ■ interrupted +│/);
});

test("a verdict: requirements down the side, the judged answers across, adherence, and the stack's answer against the rest", () => {
  const verdict = {
    requirements: ["explica o que é um golem", "em duas frases"],
    judged: [
      { node: "junta", items: ["met", "met"] as const, adherence: 100 },
      { node: "gpubox", items: ["met", "missing"] as const, adherence: 50, note: "escreveu quatro frases" },
      { node: "desk", items: ["met", "partial"] as const, adherence: 75 },
    ],
  };
  const rows = verdictRows({ requirements: verdict.requirements, judged: verdict.judged.map((j) => ({ ...j, items: [...j.items] })) }, "v · vertex/google/gemini-3.5-flash", ["junta"], 80, false);
  expect(rows).toEqual([
    " ◇ adherence to the request · judged by v · vertex/google/gemini-3.5-flash",
    "                                             junta      gpubox     desk",
    " 1. explica o que é um golem                 ✓          ✓          ✓",
    " 2. em duas frases                           ✓          ✕          ~",
    " adherence                                   100/100    50/100     75/100",
    " junta: +25 over the best of the others (desk 75)",
    " gpubox: escreveu quatro frases",
  ]);
});

test("side by side, the comparison gets each answer's adherence when a verifier judged them", () => {
  const a = done("gpubox", "gpubox/ollama/lfm3", "20");
  const b = done("desk", "desk/llama.cpp/qwen2.5-7b", "6");
  const rows = comparisonRows([a, b], 100, false, { gpubox: 100, desk: 0 });
  expect(rows.slice(0, 3)).toEqual(["              gpubox       desk", " status       ✓ answered   ✓ answered", " adherence    100/100      0/100"]);
});

test("a node waiting for the person shows the answers to choose from, by letter, side by side; then who chose and why", () => {
  const stack: StackConfig = { nodes: { gpubox: { model: "gpubox/ollama/lfm3" }, desk: { model: "desk/llama.cpp/qwen2.5-7b" }, escolha: { model: "m/c", role: "choose", from: ["gpubox", "desk"], by: ["person", "model"] } } };
  const view = stackView("escolhe", stack, 0);
  expect(view.outputs).toEqual(["escolha"]);
  applyStackEvent(view, { type: "end", node: "gpubox", result: done("gpubox", "gpubox/ollama/lfm3", "Claro. - um - dois - três") }, 0);
  applyStackEvent(view, { type: "end", node: "desk", result: done("desk", "desk/llama.cpp/qwen2.5-7b", "- um\n- dois\n- três") }, 0);
  applyStackEvent(view, { type: "start", node: "escolha", model: "m/c" }, 0);
  applyStackEvent(view, { type: "asking", node: "escolha", options: [{ label: "A", node: "gpubox" }, { label: "B", node: "desk" }] }, 0);
  const rows = stackRows(view, 100, 0, false);
  expect(rows.some((r) => r === " └ ◐ escolha  m/c · 0.0s · waiting for you to choose")).toBe(true);
  const ask = rows.indexOf(" ? escolha: choose the answer · the number below picks it");
  expect(rows[ask + 1]).toMatch(/^ A · gpubox · gpubox\/ollama\/lfm3 +│ B · desk · desk\/llama\.cpp\/qwen2\.5-7b$/);
  expect(rows[ask + 2]).toMatch(/^ Claro\. - um - dois - três +│ - um$/);
  const chosen = { ...done("escolha", "m/c", "- um\n- dois\n- três"), role: "choose" as const, choice: { node: "desk", label: "B", by: "person" as const, passed: [] as string[] } };
  applyStackEvent(view, { type: "delta", node: "escolha", text: "- um\n- dois\n- três" }, 0);
  applyStackEvent(view, { type: "end", node: "escolha", result: { ...chosen, choice: { node: "desk", label: "B", by: "model", why: "segue o formato", passed: ["person: did not choose"] } } }, 0);
  const after = stackRows(view, 100, 0, false);
  expect(after.some((r) => r.includes("waiting for you to choose") || r.includes("choose the answer"))).toBe(false);
  expect(after.slice(-5)).toEqual([" - um", " - dois", " - três", " escolha chose desk (B), by model: segue o formato", " passed over person: did not choose"]);
  expect(after.find((r) => r.startsWith(" └ ✓ escolha"))).toContain("chose desk (B)");
});
