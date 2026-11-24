import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCopies, Copy, looseFiles, removeLeftovers, repoOf, Snapshots } from "../src/core/copies.ts";
import { Fence } from "../src/core/fence.ts";
import { detectCommands, projectCommands } from "../src/core/project.ts";
import type { ChatRequest, Provider } from "../src/core/providers/provider.ts";
import { Router } from "../src/core/router.ts";
import { NOTHING_APPLIED, pace, StackRunner } from "../src/core/stack-run.ts";
import { choosePrompt, readVerdict, stackProblems, verifyPrompt, withChanges, withCheck } from "../src/core/stack.ts";
import { Trace } from "../src/core/trace.ts";
import { ProviderError, type Config, type StackConfig } from "../src/core/types.ts";
import { nodeLine } from "../src/cli/output.ts";
import { changesRows } from "../src/cli/stack-view.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-write-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const worktrees = (repo: string) => git(repo, "worktree", "list").trim().split("\n").length;
/** What the person's repository holds: the measuring never writes there. */
const objects = (repo: string) => git(repo, "count-objects", "-v");
/** The copies of a session, as directories (their diffs and Kli's mark are files). */
const copiesOf = (t: Trace) => {
  const dir = t.file.replace(/\.jsonl$/, ".copies");
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
};

/** A repository with a commit, a change not committed yet and a new file: the folder as the person has it. */
function repo(name: string): string {
  const path = join(dir, name);
  mkdirSync(path);
  git(path, "init", "-q");
  writeFileSync(join(path, "a.txt"), "one\n");
  git(path, "add", "a.txt");
  git(path, "commit", "-q", "-m", "first");
  writeFileSync(join(path, "a.txt"), "one\ntwo\n");
  writeFileSync(join(path, "new.txt"), "fresh\n");
  return path;
}

const config: Config = { locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "a" } } } } };

/**
 * Fake models: "write-X" writes X to out.txt, then says so; "bash-…" runs the command after the dash; "judge-w"
 * judges A and B as meeting the one requirement. Every call is kept.
 */
function fakes() {
  const calls: { model: string; request: ChatRequest }[] = [];
  const router = new Router(config, (name, cfg): Provider => ({
    name,
    model: cfg.model,
    async chat(request) {
      calls.push({ model: cfg.model, request: { ...request, messages: [...request.messages] } });
      const m = cfg.model;
      const last = request.messages.at(-1)!;
      if (m === "judge-given") return { text: '{"requirements": ["says hi"], "answers": {"A": {"items": ["met", "met"]}, "B": {"items": ["missing", "met"]}}}' };
      if (m === "judge-w") return { text: '{"requirements": ["writes the word"], "answers": {"A": {"items": ["met"]}, "B": {"items": ["met"]}}}' };
      // writes once, then looks again and again in small steps (more than any old limit), and then answers
      if (m === "looper") {
        const looked = request.messages.filter((x) => x.role === "tool").length;
        if (last.role === "user") return { text: "", toolCalls: [{ id: "w1", name: "Write", input: { file_path: "loop.txt", content: "x\n" } }] };
        return looked > 200 ? { text: "looper done" } : { text: "", toolCalls: [{ id: `g${calls.length}`, name: "Glob", input: { pattern: "*" } }] };
      }
      // writes, then answers only when stopped
      if (m.startsWith("writehang-")) {
        if (last.role === "user") return { text: "", toolCalls: [{ id: "w1", name: "Write", input: { file_path: "out.txt", content: `${m.slice(10)}\n` } }] };
        await new Promise((_, reject) => {
          const stop = () => reject(new ProviderError(name, "interrupted"));
          if (request.signal?.aborted) stop();
          request.signal?.addEventListener("abort", stop);
        });
      }
      // writes, then its model fails before it answers
      if (m.startsWith("writefail-")) {
        if (last.role === "user") return { text: "", toolCalls: [{ id: "w1", name: "Write", input: { file_path: "out.txt", content: `${m.slice(10)}\n` } }] };
        throw new ProviderError("mac/o", "connection reset");
      }
      if (m.startsWith("write-") && last.role === "user") return { text: "", toolCalls: [{ id: "w1", name: "Write", input: { file_path: "out.txt", content: `${m.slice(6)}\n` } }] };
      if (m.startsWith("bash-") && last.role === "user") return { text: "", toolCalls: [{ id: "b1", name: "Bash", input: { command: m.slice(5).replaceAll("_", " ") } }] };
      return { text: `${m} done`, inputTokens: 5, outputTokens: 2 };
    },
  }));
  return { router, calls };
}
const trace = () => new Trace(join(dir, "sessions"), { user: "test", surface: "test" });
/** A second node that writes and changes nothing: with two, the nodes that write work in copies. */
const quiet = { model: "mac/o/says", tools: "write" } as const;

test("a copy is a plain copy of the folder (its .git and ignored files too), measured in Kli's own git, and applied file by file", async () => {
  const folder = repo("copy");
  writeFileSync(join(folder, ".gitignore"), "deps/\n");
  mkdirSync(join(folder, "deps"));
  writeFileSync(join(folder, "deps", "lib.js"), "dep\n");
  const before = objects(folder);
  const where = await repoOf(folder);
  const snapshots = await Snapshots.open(join(dir, "copies", ".snapshots"), where);
  const copy = await Copy.make(folder, join(dir, "copies", "x"), snapshots, where);
  expect(readFileSync(join(copy.root, "a.txt"), "utf8")).toBe("one\ntwo\n");
  expect(readFileSync(join(copy.root, "new.txt"), "utf8")).toBe("fresh\n");
  // what git ignores comes too (the dependencies: nothing to set up), and a repository of its own
  expect(readFileSync(join(copy.root, "deps", "lib.js"), "utf8")).toBe("dep\n");
  expect(lstatSync(join(copy.path, ".git")).isDirectory()).toBe(true);
  expect((await copy.changes()).files).toEqual([]);

  writeFileSync(join(copy.root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(copy.root, "b.txt"), "bee\n");
  writeFileSync(join(copy.root, "c.bin"), new Uint8Array([0, 159, 146, 150, 0, 1]));
  rmSync(join(copy.root, "new.txt"));
  writeFileSync(join(copy.root, "deps", "more.js"), "ignored\n");
  // what a test run leaves, in a project that does not ignore it, is not the node's work
  mkdirSync(join(copy.root, "__pycache__"));
  writeFileSync(join(copy.root, "__pycache__", "a.cpython-313.pyc"), "x");
  const changes = await copy.changes();
  expect(changes.files).toEqual([
    { path: "a.txt", added: 1, removed: 0 },
    { path: "b.txt", added: 1, removed: 0 },
    { path: "c.bin", added: 0, removed: 0, binary: true },
    { path: "new.txt", added: 0, removed: 1 },
  ]);
  expect({ added: changes.added, removed: changes.removed }).toEqual({ added: 2, removed: 1 });
  // the person's folder is untouched until the changes are applied, and then its index stays as it was
  expect(existsSync(join(folder, "b.txt"))).toBe(false);
  await copy.apply(changes);
  expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("bee\n");
  expect([...readFileSync(join(folder, "c.bin"))]).toEqual([0, 159, 146, 150, 0, 1]);
  expect(existsSync(join(folder, "new.txt"))).toBe(false);
  expect(existsSync(join(folder, "deps", "more.js"))).toBe(false);
  expect(git(folder, "diff", "--cached", "--name-only")).toBe("");
  // nothing was written in the person's repository, and nothing registered there
  expect(objects(folder)).toBe(before);
  expect(worktrees(folder)).toBe(1);
  // the folder no longer is as the copy started: those files are the person's now, and nothing is applied
  await expect(copy.apply(changes)).rejects.toThrow("you changed a.txt, b.txt, c.bin, new.txt in your folder while the nodes worked: nothing was applied");

  await copy.remove();
  expect(existsSync(copy.path)).toBe(false);
});

test("nodes that write: each in its own copy, the check run in each, the diffs to whoever judges, and the person's folder untouched", async () => {
  const folder = repo("stack");
  const { router, calls } = fakes();
  const stack: StackConfig = {
    nodes: {
      a: { model: "mac/o/write-alfa", tools: "write" },
      b: { model: "mac/o/write-beta", tools: "write" },
      judge: { model: "mac/o/judge-w", role: "verify", from: ["a", "b"] },
    },
    write: { check: "grep -q alfa out.txt" },
  };
  const t = trace();
  const runner = new StackRunner(router, t, "s", stack, { root: folder });
  const doing: string[] = [];
  const r = await runner.send("write your word", { onEvent: (e) => e.type === "doing" && doing.push(`${e.node}: ${e.what}`) });
  const [a, b, judge] = r.nodes;
  expect(copiesOf(t).sort()).toEqual([".snapshots", "a", "b"]);
  expect(a!.changes!.files).toEqual([{ path: "out.txt", added: 1, removed: 0 }]);
  expect({ a: a!.check!.ok, b: b!.check!.ok, bExit: b!.check!.code }).toEqual({ a: true, b: false, bExit: 1 });
  expect(existsSync(join(folder, "out.txt"))).toBe(false);
  expect(readFileSync(a!.changes!.patchFile!, "utf8")).toContain("+alfa");
  expect(doing).toContain("a: making its copy of the folder");
  expect(doing).toContain("b: checking: grep -q alfa out.txt");

  // the judge sees each diff and how the check ended (in one round or two: it judges each answer as it comes); the
  // check is one more requirement, marked by Kli
  const judged = calls.filter((c) => c.model === "judge-w").map((c) => c.request.messages.at(-1)!.content).join("\n");
  expect(judged).toContain('<changes files="1" added="1" removed="0">');
  expect(judged).toContain('<check command="grep -q alfa out.txt" passed="no" exit="1">');
  expect(judge!.verdict!.requirements).toEqual(["writes the word", "the project's check passes (grep -q alfa out.txt)"]);
  expect(judge!.verdict!.judged.map((j) => [j.node, j.adherence]).sort()).toEqual([["a", 100], ["b", 50]]);
  // the node's instructions say it works in a copy
  expect(calls.find((c) => c.model === "write-alfa")!.request.messages[0]!.content).toContain("you work in a copy of the project that is only yours");
  // and how to work: to the request, at a pace that fits its time (a model with no limit for its whole answer)
  expect(calls.find((c) => c.model === "write-alfa")!.request.messages[0]!.content).toContain("Work to the request, at a steady pace: nothing cuts this step off, but the person is waiting for it.\n- Search before you read");

  // applying a: the folder gets its changes, and the round ends: every copy goes away, a's too; the diffs stay
  await runner.apply(a!);
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("alfa\n");
  expect(copiesOf(t)).toEqual([]);
  expect(existsSync(a!.changes!.patchFile!)).toBe(true);
  expect(worktrees(folder)).toBe(1);
  // the next request is a new round, from new copies of the folder as it is now
  const again = await runner.send("write it again");
  expect(again.nodes[1]!.changes!.files).toEqual([{ path: "out.txt", added: 1, removed: 1 }]);
  expect(again.nodes[0]!.changes!.files).toEqual([]);
  await runner.close();
  expect(copiesOf(t)).toEqual([]);
});

test("with no change applied (none, Esc, a new request), every copy goes away and each node hears it", async () => {
  const folder = repo("discard");
  const { router, calls } = fakes();
  const t = trace();
  const runner = new StackRunner(router, t, "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: folder });
  await runner.send("write");
  expect(copiesOf(t).sort()).toEqual([".snapshots", "a", "z"]);
  await runner.discard();
  expect(copiesOf(t)).toEqual([]);
  expect(existsSync(join(folder, "out.txt"))).toBe(false);
  // the next request tells each node that writes; a request with no round closed ends it the same way
  await runner.send("again");
  const told = (model: string) => calls.filter((c) => c.model === model).map((c) => c.request.messages.at(-1)!.content.includes(NOTHING_APPLIED));
  expect(told("write-alfa")).toEqual([false, false, true, false]);
  expect(told("says")).toEqual([false, true]);
  await runner.send("and again");
  expect(told("says")).toEqual([false, true, true]);
  await runner.close();
});

test("a request right after none: the new round's copies wait for the old ones to go, and are whole", async () => {
  const folder = repo("quick");
  const t = trace();
  const runner = new StackRunner(fakes().router, t, "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: folder });
  await runner.send("write");
  // the screen does not wait for the copies to go
  void runner.discard();
  const r = await runner.send("write again");
  expect(r.nodes[0]!.changes!.files).toEqual([{ path: "out.txt", added: 1, removed: 0 }]);
  expect(readFileSync(join(t.file.replace(/\.jsonl$/, ".copies"), "a", "a.txt"), "utf8")).toBe("one\ntwo\n");
  await runner.apply(r.nodes[0]!);
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("alfa\n");
  await runner.close();
  expect(copiesOf(t)).toEqual([]);
});

test("Esc in the middle of a round: what the nodes that ended changed can still be applied", async () => {
  const folder = repo("esc");
  const t = trace();
  const runner = new StackRunner(fakes().router, t, "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, slow: { model: "mac/o/writehang-beta", tools: "write" } } }, { root: folder });
  const esc = new AbortController();
  const stopped = await runner.send("write", { signal: esc.signal, onEvent: (e) => e.type === "end" && e.node === "a" && esc.abort() }).catch((e: { result?: { nodes: { node: string; status: string; changes?: { files: { path: string }[] } }[] } }) => e.result);
  const [a, slow] = stopped!.nodes;
  expect([a!.status, slow!.status]).toEqual(["ok", "interrupted"]);
  // the one that was stopped had changed a file too: kept, to be offered after the others
  expect(slow!.changes!.files.map((f) => f.path)).toEqual(["out.txt"]);
  await runner.apply(a as Parameters<StackRunner["apply"]>[0]);
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("alfa\n");
  expect(copiesOf(t)).toEqual([]);
  await runner.close();
});

test("a change the person made meanwhile to a file the node changed: nothing is applied, and the round ends", async () => {
  const folder = repo("conflict");
  const t = trace();
  const runner = new StackRunner(fakes().router, t, "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: folder });
  const r = await runner.send("write");
  writeFileSync(join(folder, "out.txt"), "mine\n");
  await expect(runner.apply(r.nodes[0]!)).rejects.toThrow("you changed out.txt in your folder while the nodes worked: nothing was applied");
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("mine\n");
  expect(copiesOf(t)).toEqual([]);
  await expect(runner.apply(r.nodes[0]!)).rejects.toThrow("the copy of a is gone: its round ended");
  await runner.close();
});

test("a folder that is a worktree of another repository: its copy gets a repository of its own, and theirs is left alone", async () => {
  const main = repo("wt-main");
  git(main, "commit", "-q", "-am", "second");
  const wt = join(dir, "wt-linked");
  git(main, "worktree", "add", "-q", "-b", "feature", wt);
  writeFileSync(join(wt, "a.txt"), "changed in the worktree\n");
  const t = trace();
  const runner = new StackRunner(fakes().router, t, "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: wt });
  const r = await runner.send("write");
  const copy = join(t.file.replace(/\.jsonl$/, ".copies"), "a");
  expect(lstatSync(join(copy, ".git")).isDirectory()).toBe(true);
  expect(git(copy, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature");
  expect(git(copy, "status", "--porcelain").trim()).toBe("M a.txt\n?? out.txt");
  expect(r.nodes[0]!.changes!.files.map((f) => f.path)).toEqual(["out.txt"]);
  // the copy's git is its own: a commit there moves no branch of theirs
  const head = git(main, "rev-parse", "feature");
  git(copy, "commit", "-q", "-am", "in the copy");
  expect(git(main, "rev-parse", "feature")).toBe(head);
  expect(worktrees(main)).toBe(2);
  await runner.apply(r.nodes[0]!);
  expect(readFileSync(join(wt, "out.txt"), "utf8")).toBe("alfa\n");
  await runner.close();
});

test("the only node that writes edits the folder itself: no copy, an old setup ignored, what it changed in each answer to the judge, the check run there", async () => {
  const folder = repo("here");
  const before = objects(folder);
  const { router, calls } = fakes();
  const stack: StackConfig = {
    nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, judge: { model: "mac/o/judge-w", role: "verify", from: ["a"] } },
    write: { setup: "echo set > setup.txt", check: "grep -q alfa out.txt" },
  };
  const runner = new StackRunner(router, trace(), "s", stack, { root: folder });
  const r = await runner.send("write alfa");
  const a = r.nodes[0]!;
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("alfa\n");
  expect(existsSync(join(folder, "setup.txt"))).toBe(false);
  // only what it did: the change and the new file the person already had are not its own
  expect({ files: a.changes!.files, inFolder: a.changes!.inFolder, check: a.check?.ok }).toEqual({ files: [{ path: "out.txt", added: 1, removed: 0 }], inFolder: true, check: true });
  expect(readFileSync(a.changes!.patchFile!, "utf8")).toContain("+alfa");
  // the person's index stays as it was, and the measuring wrote nothing in their repository
  expect(git(folder, "diff", "--cached", "--name-only")).toBe("");
  expect(objects(folder)).toBe(before);
  expect(calls.find((c) => c.model === "write-alfa")!.request.messages[0]!.content).toContain("you work in the person's own folder");
  expect(calls.find((c) => c.model === "judge-w")!.request.messages.at(-1)!.content).toContain("<changes>");
  expect(changesRows(r.nodes, 100, false)[1]).toContain("· 1 file +1 −0 in your folder · check passed");
  await expect(runner.apply(a)).rejects.toThrow("a changed your folder itself: there is nothing to apply");
  // the next answer is measured from the folder as it is then
  const again = await runner.send("write alfa again");
  expect(again.nodes[0]!.changes!.files).toEqual([]);
  await runner.close();
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("alfa\n");
});

test("out of a git repository the only node that writes edits the folder, measured too (what tools make left out)", async () => {
  const plain = join(dir, "plain-here");
  mkdirSync(join(plain, "node_modules", "x"), { recursive: true });
  writeFileSync(join(plain, "notes.txt"), "mine\n");
  writeFileSync(join(plain, "node_modules", "x", "index.js"), "dep\n");
  const runner = new StackRunner(fakes().router, trace(), "s", { nodes: { n: { model: "mac/o/write-x", tools: "write" } } }, { root: plain });
  const r = await runner.send("go");
  await runner.close();
  expect({ status: r.nodes[0]!.status, files: r.nodes[0]!.changes?.files, inFolder: r.nodes[0]!.changes?.inFolder }).toEqual({ status: "ok", files: [{ path: "out.txt", added: 1, removed: 0 }], inFolder: true });
  expect(readFileSync(join(plain, "out.txt"), "utf8")).toBe("x\n");
  // a folder out of git with too many files is not a project (a home folder): counted up to the limit, tools' files left out
  expect(looseFiles(plain)).toBe(2);
  expect(looseFiles(plain, 0)).toBe(1);
});

test("in its copy a node runs the commands that read and the ones the stack allows; any other is refused", async () => {
  const folder = repo("commands");
  const run = async (write: StackConfig["write"]) => {
    const runner = new StackRunner(fakes().router, trace(), "s", { nodes: { n: { model: "mac/o/bash-touch_made.txt", tools: "write" }, z: quiet }, write }, { root: folder });
    const r = await runner.send("make a file");
    await runner.close();
    return r.nodes[0]!;
  };
  const allowed = await run({ run: ["touch"] });
  expect(allowed.tools).toEqual([{ name: "Bash", label: "Bash(touch made.txt)", ok: true }]);
  expect(allowed.changes!.files.map((f) => f.path)).toEqual(["made.txt"]);
  const refused = await run(undefined);
  expect(refused.tools[0]!.ok).toBe(false);
  expect(refused.changes!.files).toEqual([]);
  expect(existsSync(join(folder, "made.txt"))).toBe(false);
});

test("out of git, nodes that write compare in copies too: measured against how the folder was, and applied; an old setup is ignored", async () => {
  const plain = join(dir, "plain");
  mkdirSync(join(plain, "node_modules"), { recursive: true });
  writeFileSync(join(plain, "a.txt"), "one\n");
  writeFileSync(join(plain, "node_modules", "dep.js"), "dep\n");
  const t = trace();
  const stack: StackConfig = { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, b: { model: "mac/o/write-beta", tools: "write" } }, write: { setup: "echo no deps; exit 3" } };
  const runner = new StackRunner(fakes().router, t, "s", stack, { root: plain });
  const r = await runner.send("go");
  expect(r.nodes.map((n) => [n.node, n.status, n.changes?.files.map((f) => f.path)])).toEqual([["a", "ok", ["out.txt"]], ["b", "ok", ["out.txt"]]]);
  expect(readFileSync(join(t.file.replace(/\.jsonl$/, ".copies"), "b", "node_modules", "dep.js"), "utf8")).toBe("dep\n");
  await runner.apply(r.nodes[1]!);
  expect(readFileSync(join(plain, "out.txt"), "utf8")).toBe("beta\n");
  expect(copiesOf(t)).toEqual([]);
  await runner.close();
});

test("the shape: only a node that answers writes, and each allowed command is one plain command", () => {
  expect(stackProblems("s", { nodes: { a: { model: "m" }, j: { model: "m", role: "aggregate", from: ["a"], tools: "write" } } })).toEqual([
    'stack "s": node "j": only a node that answers writes (to aggregate, its tools read or are none)',
  ]);
  expect(stackProblems("s", { nodes: { a: { model: "m", tools: "write" } }, write: { run: ["bun test", "a && b", "x $HOME"], check: " " } })).toEqual([
    'stack "s": write.check is a command line',
    'stack "s": write.run: "a && b" is not one plain command (words only: no &&, ;, |, $, quotes or redirections)',
    'stack "s": write.run: "x $HOME" is not one plain command (words only: no &&, ;, |, $, quotes or redirections)',
  ]);
  expect(stackProblems("s", { nodes: { a: { model: "m" } }, write: [] as unknown as StackConfig["write"] })).toEqual(['stack "s": "write" is an object: { run, check, fence }']);
  expect(stackProblems("s", { nodes: { a: { model: "m" } }, write: { fence: { network: "yes" as unknown as boolean, write: ["relative/dir"] } } })).toEqual([
    'stack "s": write.fence.network is true or false',
    'stack "s": write.fence.write is a list of folders, each from / or ~',
  ]);
  expect(stackProblems("s", { nodes: { a: { model: "m" } }, write: { fence: false } })).toEqual([]);
});

test("what the next steps get of an answer that changed files, and the check counted only when every judged answer ran it", () => {
  const text = withChanges("Done.", { files: [{}], added: 1, removed: 0, patch: "diff --git a/x b/x\n+y\n" }, { command: "bun test", ok: false, code: 1, output: "1 fail" });
  expect(text).toBe('Done.\n\n<changes files="1" added="1" removed="0">\ndiff --git a/x b/x\n+y\n</changes>\n<check command="bun test" passed="no" exit="1">\n1 fail\n</check>');
  const verdict = { requirements: ["r"], judged: [{ node: "a", items: ["met" as const], adherence: 100 }, { node: "j", items: ["met" as const], adherence: 100 }] };
  expect(withCheck(verdict, "bun test", { a: true })).toBe(verdict);
  expect(withCheck(verdict, "bun test", { a: true, j: false }).judged.map((j) => j.adherence)).toEqual([100, 50]);
});

/** A folder with these files (the contents only matter for package.json and .kli/write.json). */
function project(name: string, files: Record<string, string>): string {
  const path = join(dir, "projects", name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), text);
  }
  mkdirSync(path, { recursive: true });
  return path;
}
const installed = () => "/usr/bin/x";

test("the project's files say how to check it: its lockfile, go.mod, Cargo.toml, uv or pip", () => {
  const scripts = (s: Record<string, string>) => JSON.stringify({ scripts: s });
  expect(detectCommands(project("bun", { "package.json": scripts({ test: "bun test", typecheck: "tsc" }), "bun.lock": "" }), installed)).toEqual({
    run: ["bun run test", "bun test", "bun run typecheck", "tsc"], check: "bun run test", source: "bun.lock",
  });
  // a Bun project with no test script still has bun's own runner, when it has test files
  expect(detectCommands(project("bun-files", { "package.json": "{}", "bun.lock": "", "src/a.test.ts": "" }), installed)?.check).toBe("bun test");
  // npm init's test script says there is none: no check
  expect(detectCommands(project("npm", { "package.json": scripts({ test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." }), "package-lock.json": "" }), installed)).toEqual({
    run: ["npm run lint", "eslint ."], source: "package-lock.json",
  });
  expect(detectCommands(project("pnpm", { "package.json": scripts({ test: "vitest" }), "pnpm-lock.yaml": "" }), installed)).toEqual({ run: ["pnpm run test", "vitest"], check: "pnpm run test", source: "pnpm-lock.yaml" });
  expect(detectCommands(project("go", { "go.mod": "module x" }), installed)).toMatchObject({ check: "go test ./...", source: "go.mod" });
  expect(detectCommands(project("rust", { "Cargo.toml": "" }), installed)).toMatchObject({ check: "cargo test" });
  expect(detectCommands(project("uv", { "uv.lock": "", "tests/test_a.py": "" }), installed)).toMatchObject({ check: "uv run pytest" });
  expect(detectCommands(project("pip", { "requirements.txt": "" }), installed)).toEqual({ run: [], source: "requirements.txt" });
  // the tool the project needs is not here: nothing runs, and it says why
  expect(detectCommands(project("pnpm-missing", { "package.json": "{}", "pnpm-lock.yaml": "" }), () => null)).toEqual({ run: [], source: "pnpm-lock.yaml, but pnpm is not installed" });
  // .NET: the solution, named when the folder has more than one, and dotnet test when it has a test project
  expect(detectCommands(project("dotnet", { "App.slnx": "", "tests/App.Tests/App.Tests.csproj": "" }), installed)).toEqual({
    run: ["dotnet test", "dotnet build"], check: "dotnet test", source: "App.slnx",
  });
  expect(detectCommands(project("dotnet-two", { "B.sln": "", "A.csproj": "" }), installed)).toMatchObject({ check: "dotnet build B.sln" });
  // nothing at the top, a back end and a front end below it: each is checked in its own folder
  const mono = project("mono", {
    "README.md": "",
    "backend/Api.slnx": "",
    "backend/tests/Api.Tests/Api.Tests.csproj": "",
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build", lint: "oxlint" } }),
    "frontend/package-lock.json": "",
    "docs/x.md": "",
  });
  expect(detectCommands(mono, installed)).toEqual({
    run: ["dotnet test", "dotnet build", "npm run lint", "oxlint"],
    check: "cd backend && dotnet test",
    source: "backend/Api.slnx + frontend/package-lock.json",
  });
  // one of them without its tool: the other still counts, and the screen says why the first does not
  expect(detectCommands(mono, (c) => (c === "dotnet" ? null : "/usr/bin/x"))).toEqual({
    run: ["npm run lint", "oxlint"], source: "backend/Api.slnx, but dotnet is not installed + frontend/package-lock.json",
  });
});

test("a script's own command runs too, when it is one plain command: never one that removes, runs others or is a runtime alone", () => {
  const run = (test: string) => detectCommands(project(`script-${test.replace(/\W+/g, "-")}`, { "package.json": JSON.stringify({ scripts: { test } }), "package-lock.json": "" }), installed)!.run;
  expect(run("jest --ci")).toEqual(["npm test", "jest --ci"]);
  expect(run("node --test")).toEqual(["npm test", "node --test"]);
  expect(run("vitest run")).toEqual(["npm test", "vitest run"]);
  for (const kept of ["node", "bun", "npx", "sh test.sh", "rm -rf dist", "NODE_ENV=test jest", "jest && echo ok", "tsc; jest", "jest > out.txt", "jest $ARGS", "jest 'a b'"])
    expect(run(kept)).toEqual(["npm test"]);
});

test("the project's .kli/write.json comes first, then the stack, then the files; the allowed commands add up", () => {
  const root = project("declared", { "package.json": JSON.stringify({ scripts: { test: "bun test" } }), "bun.lock": "", ".kli/write.json": JSON.stringify({ check: "make check", run: ["make check"] }) });
  expect(projectCommands([root], { run: ["make lint"] }, installed)).toEqual({
    check: "make check", run: ["make check", "make lint", "bun run test", "bun test"], source: ".kli/write.json + the stack + bun.lock",
  });
  // an old setup says nothing: nothing is set up
  expect(projectCommands([root], { setup: "make deps" }, installed)).toEqual({ check: "make check", run: ["make check", "bun run test", "bun test"], source: ".kli/write.json + bun.lock" });
  expect(projectCommands([project("nothing", { "README.md": "" })], undefined, installed)).toEqual({ run: [] });
  // the declaration may be at the top of the repository, when Kli runs in a folder below
  const top = project("top", { ".kli/write.json": JSON.stringify({ check: "make it" }), "app/x.txt": "" });
  expect(projectCommands([join(top, "app"), top], undefined, installed).check).toBe("make it");
  const bad = project("bad", { ".kli/write.json": JSON.stringify({ run: ["a && b"] }) });
  expect(() => projectCommands([bad], undefined, installed)).toThrow('.kli/write.json: write.run: "a && b" is not one plain command');
});

test("with no check from anyone, the nodes still write; with the project's own, its check runs", async () => {
  const folder = repo("project-file");
  const plain = new StackRunner(fakes().router, trace(), "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: folder });
  const r = await plain.send("write");
  await plain.close();
  expect({ status: r.nodes[0]!.status, files: r.nodes[0]!.changes!.files.length, check: r.nodes[0]!.check, source: r.nodes[0]!.project?.source }).toEqual({ status: "ok", files: 1, check: undefined, source: undefined });

  mkdirSync(join(folder, ".kli"));
  writeFileSync(join(folder, ".kli", "write.json"), JSON.stringify({ check: "grep -q alfa out.txt" }));
  const own = new StackRunner(fakes().router, trace(), "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: folder });
  const o = await own.send("write");
  await own.close();
  expect({ check: o.nodes[0]!.check?.ok, source: o.nodes[0]!.project?.source }).toEqual({ check: true, source: ".kli/write.json" });
});

/** Whether this system has the box a fence needs (sandbox-exec on macOS, bwrap on Linux). */
const fenced = Fence.for(["/x"]) instanceof Fence;
/** The probe goes next to this test: in a clone inside a temporary folder, the fence lets it be written. */
const underTemp = [tmpdir(), "/tmp", "/var/tmp"].some((t) => existsSync(t) && realpathSync(import.meta.dir).startsWith(realpathSync(t) + "/"));

test.skipIf(!fenced || underTemp)("the check and the node's commands run in a fence: they write in the copy, not outside it, unless the project turns it off", async () => {
  // a place outside the copy, the temporary folders and the caches: next to this test
  const outside = join(import.meta.dir, `.fence-probe-${process.pid}`);
  const folder = repo("fence");
  const run = async (fence?: false) => {
    const runner = new StackRunner(fakes().router, trace(), "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet }, write: { check: `touch ${outside} && touch inside.txt`, ...(fence === false && { fence }) } }, { root: folder });
    const r = await runner.send("write");
    await runner.close();
    return r.nodes[0]!;
  };
  try {
    const inFence = await run();
    expect(inFence.check!.ok).toBe(false);
    // macOS's box refuses the write, Linux's has the disk read-only
    expect(inFence.check!.output).toMatch(/Operation not permitted|Read-only file system/);
    expect(existsSync(outside)).toBe(false);
    expect(inFence.project!.fence).toMatch(/writes only in its copy, no network/);
    const off = await run(false);
    expect(off.check!.ok).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(off.project!.unfenced).toBe("the project turned the fence off");
  } finally {
    rmSync(outside, { force: true });
  }
});

test("the fence: the system's own box, what it lets through, and why there is none", () => {
  const mac = { platform: "darwin", which: () => "/usr/bin/sandbox-exec", home: "/Users/p" };
  const f = Fence.for(["/copy"], undefined, mac) as Fence;
  const [tool, flag, profile, ...rest] = f.wrap(["bash", "-c", "ls"]);
  expect([tool, flag, rest]).toEqual(["sandbox-exec", "-p", ["env", "KLI_FENCE=1", "DOTNET_SYSTEM_NET_DISABLEIPV6=1", "bash", "-c", "ls"]]);
  // a Kli inside a fence does not box again: the fence it is in still holds
  expect(Fence.for(["/copy"], undefined, { ...mac, inside: true })).toEqual({ none: "Kli itself runs inside a fence, which still holds" });
  expect(profile).toContain('(subpath "/copy")');
  expect(profile).toContain('(deny file-read* file-write* (subpath "/Users/p/.ssh")');
  expect(profile).toContain("(deny network*)");
  // the network, when the project lets it through; more folders it may write in
  const open = (Fence.for(["/copy"], { network: true, write: ["~/out"] }, mac) as Fence).wrap(["x"])[2]!;
  expect(open).not.toContain("(deny network*)");
  expect(open).toContain('(subpath "/Users/p/out")');
  // Linux: bwrap, the system read-only, the copy writable, a network of its own
  const linux = (Fence.for(["/copy"], undefined, { platform: "linux", which: () => "/usr/bin/bwrap", home: "/home/p" }) as Fence).wrap(["bash"]);
  expect(linux.slice(0, 4)).toEqual(["bwrap", "--ro-bind", "/", "/"]);
  expect(linux.join(" ")).toContain("--bind-try /copy /copy");
  expect(linux).toContain("--unshare-net");
  expect(Fence.for(["/copy"], undefined, { platform: "linux", which: () => null, home: "/home/p" })).toEqual({ none: "bwrap is not installed" });
  // installed, but a container without user namespaces: no box, and the screen says why instead of every command failing
  const container = { platform: "linux", which: () => "/usr/bin/bwrap", home: "/home/p", fails: () => "Creating new namespace failed: Operation not permitted" };
  expect(Fence.for(["/copy"], undefined, container)).toEqual({ none: "bwrap cannot make its box here: Creating new namespace failed: Operation not permitted" });
  expect(Fence.for(["/copy"], false, mac)).toEqual({ none: "the project turned the fence off" });
  expect(Fence.for(["/copy"], undefined, { platform: "win32", which: () => null, home: "C:/p" })).toEqual({ none: "no fence on win32" });
});

test("a command no one in a stack can allow is counted as refused, on the node's line and in the trace", async () => {
  const folder = repo("refused");
  const t = trace();
  const runner = new StackRunner(fakes().router, t, "s", { nodes: { n: { model: "mac/o/bash-dotnet_test", tools: "write" } } }, { root: folder });
  const r = await runner.send("test it");
  await runner.close();
  expect(r.nodes[0]!.tools).toEqual([{ name: "Bash", label: "Bash(dotnet test)", ok: false, refused: true }]);
  expect(nodeLine(r.nodes[0]!, false)).toContain("1 tool (1 failed, 1 refused)");
  const node = readFileSync(t.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "node");
  expect(node.refused).toBe(1);
});

test("a refused command hears what runs and the project's check by name; the test script's own command runs", async () => {
  const folder = repo("script-own");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(join(folder, "bun.lock"), "");
  const send = async (model: string) => {
    const { router, calls } = fakes();
    const runner = new StackRunner(router, trace(), "s", { nodes: { n: { model, tools: "write" } } }, { root: folder });
    const r = await runner.send("test it");
    await runner.close();
    return { node: r.nodes[0]!, heard: calls.at(-1)!.request.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n") };
  };
  // the script's own command, as the model types it, with a flag: it runs (and finds no tests here)
  const own = await send("mac/o/bash-bun_test_--bail");
  expect(own.node.tools[0]).toMatchObject({ label: "Bash(bun test --bail)" });
  expect(own.node.tools[0]!.refused).toBeUndefined();
  expect(own.heard).not.toContain("Not allowed");
  const refused = await send("mac/o/bash-make_test");
  expect(refused.node.tools[0]).toMatchObject({ ok: false, refused: true });
  expect(refused.heard).toContain("the ones that start with bun run test, bun test; the project's tests run with bun run test");
});

test("applying a node's changes is in the trace: the node, its files and its diff", async () => {
  const folder = repo("apply-trace");
  const t = trace();
  const runner = new StackRunner(fakes().router, t, "s", { nodes: { a: { model: "mac/o/write-alfa", tools: "write" }, z: quiet } }, { root: folder });
  const r = await runner.send("write");
  await runner.apply(r.nodes[0]!);
  await runner.close();
  const applied = readFileSync(t.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "apply");
  expect(applied).toMatchObject({ stack: "s", node: "a", files: ["out.txt"], added: 1, removed: 0, patch: r.nodes[0]!.changes!.patchFile });
});

test("the copies a Kli that died left are taken away by the next one (an old worktree leaves its repository's list too); a live one's stay", async () => {
  const folder = repo("leftovers");
  const sessions = join(dir, "leftover-sessions");
  const dead = join(sessions, "dead.copies");
  const live = join(sessions, "live.copies");
  const where = await repoOf(folder);
  const snapshots = await Snapshots.open(join(dir, "leftover-snapshots"), where);
  await Copy.make(folder, join(dead, "a"), snapshots, where);
  await Copy.make(folder, join(live, "a"), snapshots, where);
  // a copy an older Kli made, as a git worktree
  git(folder, "worktree", "add", "--detach", "-q", join(dead, "old"), "HEAD");
  writeFileSync(join(dead, "a.patch"), "diff");
  claimCopies(live);
  mkdirSync(dead, { recursive: true });
  // a process that is gone: one that ran and ended
  const gone = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(dead, ".owner"), String(gone));
  expect(worktrees(folder)).toBe(2);
  expect((await removeLeftovers(sessions, join(sessions, "mine.copies"))).sort()).toEqual([join(dead, "a"), join(dead, "old")]);
  expect(worktrees(folder)).toBe(1);
  expect(existsSync(join(dead, "a"))).toBe(false);
  expect(existsSync(join(dead, "a.patch"))).toBe(true);
  expect(existsSync(join(live, "a"))).toBe(true);
});

test("a verifier judges by the request and the stack's own requirements, without the config's instructions", async () => {
  const folder = repo("judge");
  const { router, calls } = fakes();
  const stack: StackConfig = {
    nodes: {
      a: { model: "mac/o/plain-a" },
      b: { model: "mac/o/plain-b" },
      judge: { model: "mac/o/judge-given", role: "verify", from: ["a", "b"], requirements: ["cites the file it changed"] },
    },
  };
  const runner = new StackRunner(router, trace(), "s", stack, { root: folder, instructions: "You are Kli. Be direct and concise." });
  await runner.send("say hi");
  await runner.close();
  const system = (model: string) => calls.find((c) => c.model === model)!.request.messages[0]!.content;
  expect(system("plain-a")).toContain("You are Kli");
  expect(system("judge-given")).not.toContain("You are Kli");
  const prompt = verifyPrompt("say hi", [{ label: "A", text: "hi" }], ["cites the file it changed"]);
  expect(prompt).toContain("1. These requirements are given, and every answer is judged on them too:\n   1. cites the file it changed");
  expect(prompt).toContain("Write the requirements and the notes in the language of the request.");
  // the given ones come first, with each answer's first marks
  const verdict = readVerdict('{"requirements": ["says hi"], "answers": {"A": {"items": ["missing", "met"]}}}', { A: "a" }, ["cites the file it changed"]);
  expect(verdict).toEqual({ requirements: ["cites the file it changed", "says hi"], judged: [{ node: "a", items: ["missing", "met"], adherence: 50 }] });
  expect(stackProblems("s", { nodes: { a: { model: "m", requirements: ["x"] } } })).toEqual(['stack "s": node "a": "requirements" is for a node that verifies (role "verify")']);
});

test("a node that fails after changing files keeps them: measured, its diff saved, its check run, and said to be unfinished", async () => {
  const folder = repo("failed-write");
  const runner = new StackRunner(fakes().router, trace(), "s", { nodes: { a: { model: "mac/o/writefail-alfa", tools: "write" }, z: quiet }, write: { check: "true" } }, { root: folder });
  const r = await runner.send("write");
  const a = r.nodes[0]!;
  expect({ status: a.status, error: a.error, files: a.changes!.files.map((f) => f.path), check: a.check?.ok }).toEqual({ status: "failed", error: "mac/o: connection reset", files: ["out.txt"], check: true });
  expect(readFileSync(a.changes!.patchFile!, "utf8")).toContain("+alfa");
  expect(changesRows(r.nodes, 100, false)[1]).toContain("· failed, not judged · 1 file +1 −0");
  // and it can still be applied
  await runner.apply(a);
  await runner.close();
  expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("alfa\n");
});

test("a judge judges the work a node left when it failed, said to be unfinished, with every diff's size side by side", async () => {
  const folder = repo("judge-unfinished");
  const { router, calls } = fakes();
  const stack: StackConfig = {
    nodes: {
      a: { model: "mac/o/writefail-alfa", tools: "write" },
      b: { model: "mac/o/write-beta", tools: "write" },
      judge: { model: "mac/o/judge-w", role: "verify", from: ["a", "b"] },
    },
    write: { check: "grep -q beta out.txt" },
  };
  const runner = new StackRunner(router, trace(), "s", stack, { root: folder });
  const r = await runner.send("write your word");
  const [a, b, judge] = r.nodes;
  expect([a!.status, a!.check?.ok, b!.check?.ok]).toEqual(["failed", false, true]);
  const prompts = calls.filter((c) => c.model === "judge-w").map((c) => c.request.messages.at(-1)!.content).join("\n");
  expect(prompts).toContain('<answer id="A" unfinished="its step failed: mac/o: connection reset">');
  expect(prompts).toContain("An answer marked unfinished did not end: its step failed after it had changed files.");
  // the sizes side by side, in whatever round the judge read them
  expect(prompts).toContain("The size of each answer's changes, side by side:\n- ");
  expect(prompts).toContain("- A: 1 file, 1 line added, 0 removed (1 line in all)");
  expect(prompts).toContain("- B: 1 file, 1 line added, 0 removed (1 line in all)");
  // judged, with its check in the verdict like the others'
  expect(judge!.verdict!.judged.map((j) => [j.node, j.items.at(-1)]).sort()).toEqual([["a", "missing"], ["b", "met"]]);
  expect(changesRows(r.nodes, 100, false).find((l) => l.includes("✎ a"))).toContain("· failed, unfinished · 1 file +1 −0");
  await runner.close();
});

test("the only node that writes fails after editing the folder: the judge still judges what it left", async () => {
  const folder = repo("judge-unfinished-here");
  const { router } = fakes();
  const runner = new StackRunner(router, trace(), "s", { nodes: { a: { model: "mac/o/writefail-alfa", tools: "write" }, judge: { model: "mac/o/judge-w", role: "verify", from: ["a"] } } }, { root: folder });
  const r = await runner.send("write");
  await runner.close();
  expect([r.nodes[0]!.status, r.nodes[1]!.status]).toEqual(["failed", "ok"]);
  expect(r.nodes[1]!.verdict!.judged.map((j) => j.node)).toEqual(["a"]);
});

test("the sizes of the changes go side by side only with two or more, and a later round keeps the ones judged before", () => {
  const A = { label: "A", text: "a", changed: true, size: { files: 2, added: 10, removed: 3 } };
  const B = { label: "B", text: "b", changed: true, size: { files: 5, added: 40, removed: 12 } };
  const C = { label: "C", text: "c", changed: true, size: { files: 0, added: 0, removed: 0 } };
  expect(verifyPrompt("r", [A], ["x"])).not.toContain("side by side");
  const later = verifyPrompt("r", [B], ["x"], [], true, [B, C, A]);
  expect(later).toContain("The size of each answer's changes, side by side:\n- A: 2 files, 10 lines added, 3 removed (13 lines in all)\n- B: 5 files, 40 lines added, 12 removed (52 lines in all)\n- C: no file changed\n");
  expect(later).toContain("of the changes that do what is asked, the smaller one meets it");
  // only B is judged in that round
  expect(later).toContain('<answer id="B">');
  expect(later).not.toContain('<answer id="A">');
  expect(choosePrompt("r", [A, B])).toContain("- B: 5 files, 40 lines added, 12 removed (52 lines in all)");
});

test("the check runs only in a copy that changed; a judge that needs it gets the folder's own result, run once", async () => {
  const folder = repo("check-changed");
  const { router } = fakes();
  const doing: string[] = [];
  const stack: StackConfig = {
    nodes: {
      a: { model: "mac/o/write-alfa", tools: "write" },
      n: { model: "mac/o/says", tools: "write" },
      judge: { model: "mac/o/judge-w", role: "verify", from: ["a", "n"] },
    },
    write: { check: "grep -q alfa out.txt" },
  };
  const runner = new StackRunner(router, trace(), "s", stack, { root: folder });
  const r = await runner.send("write your word", { onEvent: (e) => e.type === "doing" && doing.push(`${e.node}: ${e.what}`) });
  await runner.close();
  const [a, n, judge] = r.nodes;
  expect({ a: a!.check?.ok, n: n!.check }).toEqual({ a: true, n: undefined });
  expect(doing).not.toContain("n: checking: grep -q alfa out.txt");
  expect(doing).toContain("judge: checking the folder as it was: grep -q alfa out.txt");
  // the folder as it was has no out.txt: the one that changed nothing does not pass it
  expect(judge!.verdict!.requirements.at(-1)).toBe("the project's check passes (grep -q alfa out.txt)");
  // (in the order the answers came: the judge does not wait for the slowest)
  expect(judge!.verdict!.judged.map((j) => [j.node, j.items.at(-1)]).sort()).toEqual([["a", "met"], ["n", "missing"]]);

  // a question no one changed a file for: no check anywhere, and none in the verdict
  const quiet = new StackRunner(router, trace(), "s", { ...stack, nodes: { ...stack.nodes, a: { model: "mac/o/says", tools: "write" } } }, { root: folder });
  const q = await quiet.send("what is this project?");
  await quiet.close();
  expect(q.nodes.map((x) => x.check)).toEqual([undefined, undefined, undefined]);
  expect(q.nodes[2]!.verdict!.requirements).toEqual(["writes the word"]);
});

test("Python tests with no lockfile: unittest from the top (a module named like a library stays out of the way), or pytest when the project uses it", async () => {
  const pkg = project("py-plain", {
    "ingestors/csv.py": "raise SystemExit('the csv of the folder, not the library')\n",
    "ingestors/tests/test_x.py": "import csv, io, unittest\nclass T(unittest.TestCase):\n    def test_reads(self):\n        self.assertEqual(next(csv.reader(io.StringIO('a,b'))), ['a', 'b'])\n",
    "web/package.json": "{}",
  });
  const found = detectCommands(pkg, installed)!;
  expect(found).toEqual({ run: ["python3 -m unittest"], check: "python3 -m unittest discover -s ingestors/tests", source: "ingestors/tests/test_x.py + web/package.json" });
  // it really runs from the top: from inside ingestors/, its csv.py would take the library's place
  const r = Bun.spawnSync(["bash", "-c", found.check!], { cwd: pkg, stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  expect(detectCommands(project("py-top", { "tests/test_a.py": "" }), installed)!.check).toBe("python3 -m unittest discover -s tests");
  expect(detectCommands(project("py-pytest", { "conftest.py": "", "tests/test_a.py": "" }), installed)).toMatchObject({ run: ["pytest", "python3 -m pytest"], check: "python3 -m pytest ." });
  expect(detectCommands(project("py-none", { "tests/test_a.py": "" }), () => null)).toEqual({ run: [], source: "tests/test_a.py, but python3 is not installed" });
});

test("the pace a node that writes is asked for has no clock: nothing cuts it off, the person waits for it", () => {
  expect(pace().split("\n")[0]).toBe("Work to the request, at a steady pace: nothing cuts this step off, but the person is waiting for it.");
  expect(pace()).not.toMatch(/minute|stops after|cut off:|unfinished/);
  expect(pace()).toContain("When reads or edits do not depend on each other, ask for them together, in one step.");
  expect(pace()).toContain("do not read again a file you have read");
  expect(pace()).toContain("leave decisions it does not ask for to the person");
});

test("a node on Kli's loop has no limit of steps: it goes on until its model answers, and is judged", async () => {
  const folder = repo("no-limit");
  const { router, calls } = fakes();
  const stack: StackConfig = { nodes: { a: { model: "mac/o/looper", tools: "write" }, judge: { model: "mac/o/judge-w", role: "verify", from: ["a"] } } };
  const runner = new StackRunner(router, trace(), "s", stack, { root: folder });
  const r = await runner.send("go");
  await runner.close();
  const a = r.nodes[0]!;
  expect({ status: a.status, error: a.error, steps: a.steps, text: a.text, files: a.changes?.files.map((f) => f.path) }).toEqual({ status: "ok", error: undefined, steps: 202, text: "looper done", files: ["loop.txt"] });
  // never told to hurry: no note that steps or time are running out
  expect(calls.filter((c) => c.model === "looper").some((c) => c.request.messages.some((m) => m.content.includes("left: finish now")))).toBe(false);
  expect(r.nodes[1]!.status).toBe("ok");
});

