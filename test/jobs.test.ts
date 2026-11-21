import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutMiddle, duration, Job, plainText } from "../src/core/jobs.ts";
import { Router } from "../src/core/router.ts";
import { Session } from "../src/core/session.ts";
import { Workspace } from "../src/core/tools.ts";
import { Trace } from "../src/core/trace.ts";
import type { ChatRequest, Provider } from "../src/core/providers/provider.ts";
import type { Config } from "../src/core/types.ts";

const base = mkdtempSync(join(tmpdir(), "kli-jobs-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/** A workspace that says yes to everything. */
function workspace() {
  const root = join(base, `w${n++}`);
  mkdirSync(root);
  const ws = new Workspace(root);
  ws.ask = async () => "yes";
  return { root, ws };
}
const call = (name: string, input: Record<string, unknown>) => ({ id: "1", name, input });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the output comes as it is printed, stdout and stderr in order, without colors", async () => {
  const { ws } = workspace();
  const pieces: string[] = [];
  const r = await ws.run(call("Bash", { command: "echo one; sleep 0.2; echo two >&2; printf '\\033[31mred\\033[0m\\n'" }), undefined, (c) => pieces.push(c));
  expect(r.output).toBe("one\ntwo\nred\n[exit code 0]");
  expect(pieces.length).toBeGreaterThan(1); // "one" came before the command ended
  expect(pieces[0]).toBe("one\n");
});

test("a timeout stops the command and what it started", async () => {
  const { root, ws } = workspace();
  const r = await ws.run(call("Bash", { command: "sleep 30 & echo $! > child.pid; wait", timeout: 1000 }));
  expect(r.summary).toBe("timed out · 0 lines");
  expect(r.output).toContain("stopped after 1s");
  const child = Number(await Bun.file(join(root, "child.pid")).text());
  await Bun.sleep(100);
  expect(alive(child)).toBe(false);
});

test("in the background: an id at once, BashOutput gives what is new, KillBash stops it all", async () => {
  const { ws } = workspace();
  const ended: string[] = [];
  ws.onJobEnd = (job) => ended.push(`${job.id} ${job.status().split(" after")[0]}`);
  const start = await ws.run(call("Bash", { command: "echo ready; while true; do sleep 0.1; done", run_in_background: true }));
  expect(start).toMatchObject({ ok: true, summary: "running in the background as b1" });
  await Bun.sleep(300);
  const first = await ws.run(call("BashOutput", { bash_id: "b1" }));
  expect(first.output).toMatch(/^b1: running for [\d.]+s\nready$/);
  expect((await ws.run(call("BashOutput", { bash_id: "b1" }))).output).toEndWith("(nothing new)");
  expect((await ws.run(call("BashOutput", { bash_id: "b9" }))).output).toBe("There is no background command b9. There are: b1.");
  const stop = await ws.run(call("KillBash", { bash_id: "b1" }));
  expect(stop.output).toMatch(/^Stopped b1 \(echo ready; .*\): stopped after/);
  await Bun.sleep(10);
  expect(ended).toEqual(["b1 stopped"]);
  expect(ws.endedNotes()).toEqual([]); // the model stopped it: nothing to tell
});

test("Ctrl+B: the model goes on while the command keeps running in the background", async () => {
  const { ws } = workspace();
  const running = ws.run(call("Bash", { command: "echo building; sleep 0.4; echo built" }));
  await Bun.sleep(150);
  expect(ws.waitingForCommand).toBe(true);
  const job = ws.background()!;
  const r = await running;
  expect(r.summary).toBe("moved to the background as b1");
  expect(r.output).toContain("What it printed so far (the end):\nbuilding\n");
  await job.done;
  // only what came after, and the model is told it ended with the next prompt
  expect(job.unread()).toBe("built\n");
  expect(ws.endedNotes()).toEqual([expect.stringMatching(/^The background command b1 \(echo building; .*\) exited with code 0 after/)]);
  expect(ws.endedNotes()).toEqual([]);
  expect(ws.background()).toBeUndefined();
});

test("a note goes with the next prompt, before the person's words; closing stops what is left", async () => {
  const { ws } = workspace();
  const seen: ChatRequest[] = [];
  const config: Config = { locations: { mac: { type: "machine", providers: { o: { type: "server", port: 1, model: "m" } } } }, model: "mac/o/m" };
  const router = new Router(config, (name, cfg): Provider => ({ name, model: cfg.model, chat: async (r) => (seen.push({ ...r, messages: [...r.messages] }), { text: "ok" }) }));
  const session = new Session(router, new Trace(join(base, "s"), { user: "t", surface: "test" }), undefined, ws);
  session.note("The person ran: git status");
  await session.send("e agora?");
  expect(seen[0]!.messages.at(-1)!.content).toBe('<note from="kli">\nThe person ran: git status\n</note>\n\ne agora?');
  await session.send("de novo");
  expect(seen[1]!.messages.at(-1)!.content).toBe("de novo");
  await ws.run(call("Bash", { command: "sleep 30", run_in_background: true }));
  const job = ws.jobs.get("b1")!;
  await ws.close();
  expect(job.running).toBe(false);
});

test("terminal output as text: progress bars at their last state, codes and backspaces gone", () => {
  expect(plainText("\x1b[1m\x1b[32mok\x1b[0m\r\n 10%\r 50%\r100%\r\nab\x08c\x07\n\x1b]0;title\x07done")).toBe("ok\n100%\nac\ndone");
  expect(cutMiddle("a".repeat(10) + "b".repeat(10), 10)).toBe("aaaaa\n… (10 characters cut) …\nbbbbb");
  expect([duration(4200), duration(72_000), duration(7_500_000)]).toEqual(["4.2s", "1m 12s", "2h 5m"]);
  expect(existsSync(base)).toBe(true);
});

test("a job keeps the end of a very long output, and says what was dropped", async () => {
  const job = new Job("head -c 2100000 /dev/zero | tr '\\0' x", base);
  await job.done;
  expect(job.unread()).toMatch(/^… \(100000 characters were dropped\)\nx+$/);
});
