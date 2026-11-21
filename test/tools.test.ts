import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffCount, lineDiff } from "../src/core/diff.ts";
import { Workspace, type Answer, type PermissionRequest } from "../src/core/tools.ts";

const base = mkdtempSync(join(tmpdir(), "kli-tools-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/** A fresh folder with a workspace on it; `answers` are what the person says to each question, in order. */
function workspace(answers: Answer[] = []) {
  const root = join(base, `w${n++}`);
  mkdirSync(root);
  const ws = new Workspace(root);
  const asked: PermissionRequest[] = [];
  ws.ask = async (r) => {
    asked.push(r);
    return answers.shift() ?? "no";
  };
  return { root, ws, asked };
}
const call = (name: string, input: Record<string, unknown>) => ({ id: "1", name, input });

test("Read numbers the lines, in parts for a long file, and says what is left", async () => {
  const { root, ws, asked } = workspace();
  writeFileSync(join(root, "a.txt"), "um\ndois\ntrês\n");
  const r = await ws.run(call("Read", { file_path: "a.txt" }));
  expect(r).toMatchObject({ ok: true, summary: "Read 3 lines" });
  expect(r.output).toBe("     1\tum\n     2\tdois\n     3\ttrês");
  const part = await ws.run(call("Read", { file_path: "a.txt", offset: 2, limit: 1 }));
  expect(part.output).toBe("     2\tdois\n… 1 more lines (read on with offset 3)");
  expect((await ws.run(call("Read", { file_path: "nope.txt" }))).ok).toBe(false);
  expect(asked).toEqual([]); // reading inside the folder never asks
});

test("Write asks with the whole file as a diff; 'always' stops the questions for edits", async () => {
  const { root, ws, asked } = workspace(["always"]);
  const r = await ws.run(call("Write", { file_path: "src/novo.py", content: "print(1)\nprint(2)\n" }));
  expect(r).toMatchObject({ ok: true, summary: "Wrote 2 lines to src/novo.py" });
  expect(readFileSync(join(root, "src/novo.py"), "utf8")).toBe("print(1)\nprint(2)\n");
  expect(asked[0]).toMatchObject({ tool: "Write", title: "Create src/novo.py", scope: { kind: "edits" } });
  expect(asked[0]!.diff!.map((d) => d.op + d.text)).toEqual(["+print(1)", "+print(2)"]);
  // allowed for the session: no second question
  expect((await ws.run(call("Write", { file_path: "b.txt", content: "x" }))).ok).toBe(true);
  expect(asked.length).toBe(1);
});

test("an existing file must be read before it is written or edited", async () => {
  const { root, ws } = workspace(["yes", "yes"]);
  writeFileSync(join(root, "c.txt"), "a\nb\nc\n");
  expect((await ws.run(call("Write", { file_path: "c.txt", content: "z" }))).output).toContain("Read it first");
  expect((await ws.run(call("Edit", { file_path: "c.txt", old_string: "b", new_string: "B" }))).output).toContain("Read c.txt before");
  await ws.run(call("Read", { file_path: "c.txt" }));
  const r = await ws.run(call("Edit", { file_path: "c.txt", old_string: "b", new_string: "B" }));
  expect(r).toMatchObject({ ok: true, summary: "Edited c.txt: +1 −1" });
  expect(readFileSync(join(root, "c.txt"), "utf8")).toBe("a\nB\nc\n");
});

test("Edit wants old_string once (or replace_all), exactly", async () => {
  const { root, ws } = workspace(["yes"]);
  writeFileSync(join(root, "d.txt"), "x = 1\nx = 1\n");
  await ws.run(call("Read", { file_path: "d.txt" }));
  expect((await ws.run(call("Edit", { file_path: "d.txt", old_string: "x = 1", new_string: "x = 2" }))).output).toContain("appears 2 times");
  expect((await ws.run(call("Edit", { file_path: "d.txt", old_string: "y", new_string: "z" }))).output).toContain("was not found");
  const r = await ws.run(call("Edit", { file_path: "d.txt", old_string: "x = 1", new_string: "x = 2", replace_all: true }));
  expect(r.ok).toBe(true);
  expect(readFileSync(join(root, "d.txt"), "utf8")).toBe("x = 2\nx = 2\n");
});

test("no: nothing is written and the turn is told to stop; outside the folder always asks", async () => {
  const { root, ws, asked } = workspace(["no"]);
  const r = await ws.run(call("Write", { file_path: "e.txt", content: "x" }));
  expect(r).toMatchObject({ ok: false, refused: true });
  expect(existsSync(join(root, "e.txt"))).toBe(false);
  ws.mode = "acceptEdits";
  expect((await ws.run(call("Write", { file_path: "f.txt", content: "x" }))).ok).toBe(true); // no question
  const outside = await ws.run(call("Write", { file_path: join(base, "fora.txt"), content: "x" }));
  expect(outside.refused).toBe(true); // asked even in acceptEdits, and the answer (none left) was no
  expect(asked.map((a) => a.scope.kind)).toEqual(["edits", "outside"]);
});

test("without anyone to ask (kli -p), what needs permission is refused; plan mode only reads", async () => {
  const { ws } = workspace();
  ws.ask = undefined;
  expect((await ws.run(call("Bash", { command: "touch oi.txt" }))).output).toContain("no terminal to ask");
  // what only reads needs no one: it runs, even here
  expect((await ws.run(call("Bash", { command: "ls -a" }))).ok).toBe(true);
  ws.mode = "plan";
  expect(ws.specs().map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "Bash", "BashOutput", "KillBash"]);
  expect((await ws.run(call("Write", { file_path: "g.txt", content: "x" }))).summary).toBe("plan mode: read only");
  expect((await ws.run(call("Bash", { command: "touch g.txt" }))).summary).toBe("plan mode: read only");
  expect((await ws.run(call("Bash", { command: "pwd" }))).ok).toBe(true);
});

test("Bash runs in the folder; 'always' covers what starts like each part of the line, and nothing else", async () => {
  const { root, ws, asked } = workspace(["always", "no", "no"]);
  writeFileSync(join(root, "h.txt"), "oi\n");
  const r = await ws.run(call("Bash", { command: "cat h.txt && exit 3" }));
  expect(r).toMatchObject({ ok: false, summary: "exit 3 · 1 line" });
  expect(r.output).toBe("oi\n[exit code 3]");
  // cat only reads: only "exit 3" is asked about
  expect(asked[0]).toMatchObject({ command: "cat h.txt && exit 3", scope: { kind: "command", rules: [{ words: ["exit", "3"], exact: false }] } });
  expect((await ws.run(call("Bash", { command: "cat h.txt; exit 3" }))).ok).toBe(false);
  expect(asked.length).toBe(1);
  // the same first word is not enough, and an allowed part does not carry another one along
  expect((await ws.run(call("Bash", { command: "cat h.txt && rm h.txt" }))).refused).toBe(true);
  expect(asked[1]!.scope).toEqual({ kind: "command", rules: [{ words: ["rm", "h.txt"], exact: true }] });
  expect((await ws.run(call("Bash", { command: "cat $(echo h.txt)" }))).refused).toBe(true);
  expect(asked[2]!.scope).toMatchObject({ kind: "once", why: "it has a command inside another ($(…) or `…`)" });
  expect(existsSync(join(root, "h.txt"))).toBe(true);
});

test("a command that writes outside the folder asks every time", async () => {
  const { ws, asked } = workspace(["yes"]);
  ws.rules.push({ words: ["echo"], exact: false });
  expect((await ws.run(call("Bash", { command: "echo oi" }))).ok).toBe(true);
  expect(asked.length).toBe(0);
  await ws.run(call("Bash", { command: `echo oi > ${join(base, "fora.log")}` }));
  expect(asked[0]!.scope).toMatchObject({ kind: "once", why: expect.stringContaining("outside the folder") });
});

test("Glob and Grep look inside the folder; Glob shows the folders too", async () => {
  const { root, ws, asked } = workspace();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const vendas = 1;\n");
  writeFileSync(join(root, "src/b.md"), "nada\n");
  writeFileSync(join(root, "vendas.csv"), "a\n");
  expect((await ws.run(call("Glob", { pattern: "**/*.ts" }))).output).toBe("src/a.ts");
  const top = await ws.run(call("Glob", { pattern: "*" }));
  expect(top.output.split("\n").sort()).toEqual(["src/", "vendas.csv"]);
  expect(top.summary).toBe("Found 1 file and 1 folder");
  // and listing it with ls does not ask, as in Claude Code
  const ls = await ws.run(call("Bash", { command: "ls" }));
  expect(ls.output).toBe("src\nvendas.csv\n[exit code 0]");
  expect(asked).toEqual([]);
  const grep = await ws.run(call("Grep", { pattern: "vendas", output_mode: "content" }));
  expect(grep.output).toBe("src/a.ts:1:export const vendas = 1;");
});

test("the diff keeps only the changes and their context", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
  const after = before.replace("l10", "L10");
  const d = lineDiff(before, after);
  expect(d.map((x) => `${x.op}${x.text}`)).toEqual([" l7", " l8", " l9", "-l10", "+L10", " l11", " l12", " l13"]);
  expect(diffCount(d)).toEqual({ added: 1, removed: 1 });
});
