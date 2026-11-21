import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldersBelow, InstructionReader, instructionsPrompt, loadInstructions } from "../src/core/instructions.ts";
import { Router } from "../src/core/router.ts";
import { Session } from "../src/core/session.ts";
import { Workspace } from "../src/core/tools.ts";
import { Trace } from "../src/core/trace.ts";
import type { Config } from "../src/core/types.ts";

const base = mkdtempSync(join(tmpdir(), "kli-instr-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/** A project inside a parent folder, and a ~/.kli of its own; `files` are written relative to the parent. */
function tree(files: Record<string, string>) {
  const top = join(base, `t${n++}`);
  const user = join(top, "user");
  const project = join(top, "parent", "project");
  mkdirSync(user, { recursive: true });
  mkdirSync(project, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(top, path, ".."), { recursive: true });
    writeFileSync(join(top, path), content);
  }
  return { top, user, project };
}
const shownOf = (files: { shown: string }[]) => files.map((f) => f.shown);

test("both names, in ~/.kli and in every folder down to the project, the closer the later", () => {
  const { user, project } = tree({
    "user/AGENTS.md": "mine",
    "parent/CLAUDE.md": "of the parent",
    "parent/project/AGENTS.md": "use bun",
    "parent/project/CLAUDE.md": "and tests",
  });
  const files = loadInstructions(new InstructionReader(project, "/nowhere"), user);
  expect(files.map((f) => f.content)).toEqual(["mine", "of the parent", "use bun", "and tests"]);
  expect(shownOf(files).slice(2)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  expect(files[1]!.shown).toEndWith("/parent/CLAUDE.md");
});

test("CLAUDE.local.md, the person's own and out of Git, comes right after CLAUDE.md in its folder, so it wins", () => {
  const { user, project } = tree({
    "parent/project/CLAUDE.local.md": "push only when I say so",
    "parent/project/CLAUDE.md": "open a PR for every change",
    "parent/project/AGENTS.md": "use bun",
  });
  const files = loadInstructions(new InstructionReader(project, "/nowhere"), user);
  expect(shownOf(files)).toEqual(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]);
  expect(instructionsPrompt(files)).toContain("(AGENTS.md, CLAUDE.md, CLAUDE.local.md)");
});

test("a CLAUDE.md that only brings in AGENTS.md, a symlink and a copy are read once", () => {
  const { user, project } = tree({ "parent/project/AGENTS.md": "use bun", "parent/project/CLAUDE.md": "@AGENTS.md\n" });
  expect(shownOf(loadInstructions(new InstructionReader(project, "/nowhere"), user))).toEqual(["AGENTS.md"]);
  const two = tree({ "parent/project/AGENTS.md": "use bun" });
  symlinkSync(join(two.project, "AGENTS.md"), join(two.project, "CLAUDE.md"));
  expect(loadInstructions(new InstructionReader(two.project, "/nowhere"), two.user).length).toBe(1);
  const three = tree({ "parent/project/AGENTS.md": "use bun", "parent/project/CLAUDE.md": "use bun\n" });
  expect(loadInstructions(new InstructionReader(three.project, "/nowhere"), three.user).length).toBe(1);
});

test("@path brings a file in after the one that names it; not inside code, not when there is no such file", () => {
  const { user, project } = tree({
    "parent/project/AGENTS.md": "Build: see @docs/build.md.\nAsk @alexandre.\n`@docs/nope.md` and\n```\n@docs/deploy.md\n```",
    "parent/project/docs/build.md": "bun run build\n@deploy.md",
    "parent/project/docs/deploy.md": "rsync dist/",
  });
  const files = loadInstructions(new InstructionReader(project, "/nowhere"), user);
  expect(shownOf(files)).toEqual(["AGENTS.md", "docs/build.md", "docs/deploy.md"]);
  expect(files[1]).toMatchObject({ imported: true, content: "bun run build\n@deploy.md" });
});

test("the model gets them in the system prompt, read again for each new session", () => {
  const { user, project } = tree({ "parent/project/AGENTS.md": "Always answer in Portuguese." });
  const config: Config = { locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "m" } } } }, model: "mac/o/m" };
  const ws = new Workspace(project, user);
  const session = () => new Session(new Router(config), new Trace(join(base, "s"), { user: "t", surface: "test" }), "Be brief.", ws);
  const system = (s: Session) => (s as unknown as { messages: { content: string }[] }).messages[0]!.content;
  expect(system(session())).toContain('<instructions file="AGENTS.md">\nAlways answer in Portuguese.\n</instructions>');
  writeFileSync(join(project, "CLAUDE.md"), "Run the tests before saying it is done.");
  expect(system(session())).toContain("Run the tests before saying it is done.");
  expect(shownOf(ws.loaded)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  expect(instructionsPrompt([])).toBe("");
});

test("a folder below gets its instructions the first time the model reads a file there", async () => {
  const { user, project } = tree({ "parent/project/web/AGENTS.md": "This is the front end: npm run dev.", "parent/project/web/src/app.ts": "x\n" });
  const ws = new Workspace(project, user);
  ws.instructions();
  const first = await ws.run({ id: "1", name: "Read", input: { file_path: "web/src/app.ts" } });
  expect(first.output).toContain('<instructions file="web/AGENTS.md">');
  expect(first.summary).toBe("Read 1 line · instructions in web/AGENTS.md");
  const again = await ws.run({ id: "2", name: "Read", input: { file_path: "web/src/app.ts" } });
  expect(again.output).not.toContain("<instructions");
  expect(foldersBelow("/a/b", "/a/b/c/d/e.ts")).toEqual(["/a/b/c", "/a/b/c/d"]);
  expect(foldersBelow("/a/b", "/a/x.ts")).toEqual([]);
});
