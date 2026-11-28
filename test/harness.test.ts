import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PRESETS } from "../src/core/presets.ts";
import { agentTool, HarnessProvider, harnessPrompt, lastMessage } from "../src/core/providers/harness.ts";
import type { AgentToolEvent } from "../src/core/providers/provider.ts";
import type { HarnessProviderConfig } from "../src/core/types.ts";

const fake = join(import.meta.dir, "fixtures", "fake-harness.ts");
const harness = (mode: string, extra: Partial<HarnessProviderConfig> = {}) =>
  new HarnessProvider("fake", { type: "harness", command: process.execPath, model: "fake", args: [fake, mode], format: "text", ...extra });
const ask = [{ role: "user" as const, content: "oi" }];

test("the conversation becomes one prompt: instructions, earlier turns, then the new message", () => {
  expect(harnessPrompt(ask)).toBe("oi");
  expect(
    harnessPrompt([
      { role: "system", content: "Be brief." },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]),
  ).toBe("<instructions>\nBe brief.\n</instructions>\n\n<conversation>\nUser: a\n\nAssistant: b\n</conversation>\n\nc");
});

test("Claude Code stream-json: text deltas, non-JSON lines skipped, tokens include the cache, cost kept", async () => {
  const deltas: string[] = [];
  const r = await harness("claude", { format: "claude" }).chat({ messages: ask, onDelta: (t) => deltas.push(t) });
  expect(deltas).toEqual(["Hel", "lo"]);
  expect(r).toEqual({ text: "Hello", inputTokens: 2712, outputTokens: 4, costUsd: 0.0005 });
});

test("without partial messages the whole answer comes from the result; the prompt went through stdin", async () => {
  const r = await harness("claude-whole", { format: "claude" }).chat({ messages: [{ role: "user", content: "12345" }] });
  expect(r.text).toBe("got 5 chars");
});

test("Antigravity stream-json: only agent_response deltas, thinking counted as output", async () => {
  const r = await harness("agy", { format: "antigravity" }).chat({ messages: ask });
  expect(r).toEqual({ text: "ok", inputTokens: 6027, outputTokens: 3, thinkingTokens: 2, costUsd: undefined });
});

test("text mode streams stdout; {prompt} puts the prompt in the arguments", async () => {
  const r = await harness("text", { args: [fake, "text", "{prompt}"] }).chat({ messages: ask });
  expect(r.text).toBe("echo: oi");
});

test("a failing harness reports its exit code and last stderr line; an error result is reported as such", async () => {
  await expect(harness("fail").chat({ messages: ask })).rejects.toThrow(/exited with code 3: boom: not logged in/);
  await expect(harness("claude-error", { format: "claude" }).chat({ messages: ask })).rejects.toThrow("Credit balance is too low");
});

test("a missing command says so", async () => {
  const p = new HarnessProvider("ghost", { type: "harness", command: "kli-no-such-harness", model: "x" });
  await expect(p.chat({ messages: ask })).rejects.toThrow("command not found: kli-no-such-harness");
});

test("interrupting kills the harness and keeps what already arrived", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const p = harness("slow").chat({ messages: ask, signal: controller.signal, onDelta: () => controller.abort() });
  await expect(p).rejects.toMatchObject({ message: "interrupted", afterText: true });
  expect(performance.now() - started).toBeLessThan(5000);
});

test("trailing line breaks are held back: what streamed is exactly the text returned", async () => {
  const deltas: string[] = [];
  const r = await harness("agy", { format: "antigravity" }).chat({ messages: ask, onDelta: (t) => deltas.push(t) });
  expect(deltas.join("")).toBe(r.text);
  expect(r.text).toBe("ok");
});

test("OpenCode JSON: text parts and the step's tokens; {model} reaches the arguments", async () => {
  const r = await harness("opencode", { format: "opencode" }).chat({ messages: ask });
  expect(r).toEqual({ text: "ok", inputTokens: 900, outputTokens: 2, costUsd: undefined });
  const echo = await harness("text", { model: "gemini-x", args: [fake, "text", "--model={model}"] }).chat({ messages: ask });
  expect(echo.text).toBe("echo: --model=gemini-x");
});

const modes = { isolated: ["--alone"], plan: ["--plan"], agent: ["--yes"] };
const where = (extra: Partial<HarnessProviderConfig> = {}) => harness("where", { args: [fake, "where", "{prompt}", "{mode}"], modes, ...extra });

test("a CLI Kli knows works as an agent in the person's folder; in plan mode it only reads; alone for a test", async () => {
  const root = realpathSync(tmpdir());
  expect((await where().chat({ messages: ask, workspace: { root, mode: "default" } })).text).toBe(`${root} | --yes`);
  expect((await where().chat({ messages: ask, workspace: { root, mode: "acceptEdits" } })).text).toBe(`${root} | --yes`);
  expect((await where().chat({ messages: ask, workspace: { root, mode: "plan" } })).text).toBe(`${root} | --plan`);
  // no folder (kli check) or another machine: isolated, in the neutral folder
  expect((await where().chat({ messages: ask })).text).toEndWith("/.kli/harness | --alone");
  expect(where({ ssh: ["ssh", "desk"] }).how({ root, mode: "default" })).toEqual({ mode: "isolated", args: ["--alone"] });
  // without a plan mode of its own (Kimi in prompt mode), plan mode keeps it away from the folder
  expect((await where({ modes: { ...modes, plan: [] } }).chat({ messages: ask, workspace: { root, mode: "plan" } })).text).toEndWith("/.kli/harness | --alone");
  // $PWD says the same folder, not where the terminal was
  const pwd = harness("pwd", { args: [fake, "pwd", "{prompt}", "{mode}"], modes });
  expect((await pwd.chat({ messages: ask, workspace: { root, mode: "plan" } })).text).toBe(root);
});

/** The tool steps a CLI reported, as Kli shows them. */
async function steps(mode: string, format: HarnessProviderConfig["format"]) {
  const seen: string[] = [];
  const r = await harness(mode, { format }).chat({
    messages: ask,
    workspace: { root: process.cwd(), mode: "default" },
    onAgentTool: (e) => seen.push(e.phase === "start" ? `start ${e.label}` : `end ${e.label} ${e.ok ? "✓" : "✕"} ${e.summary}`),
  });
  expect(r.text).toBe("feito");
  return seen;
}

test("each CLI's own tools become steps on screen, in Claude Code's names, paths relative to the folder", async () => {
  expect(await steps("claude-tools", "claude")).toEqual([
    "start Bash(ls -la . && echo oi > oi.txt)",
    "end Bash(ls -la . && echo oi > oi.txt) ✓ 2 lines",
    "start Read(nada.txt)",
    "end Read(nada.txt) ✕ failed · 1 line",
  ]);
  expect(await steps("agy-tools", "antigravity")).toEqual([
    "start Bash(ls -la)",
    "end Bash(ls -la) ✓ exit 0 · 2 lines",
    "start Write(oi.txt)",
    "end Write(oi.txt) ✓ done",
    // agy says only how much it read; a long output comes after its note, with the exit code inside
    "end Read(package.json) ✓ Read 17 lines",
    "end Bash(bun test) ✕ failed · exit 1 · 5 lines",
  ]);
  expect(await steps("opencode-tools", "opencode")).toEqual(["start Bash(false)", "end Bash(false) ✕ failed · exit 1 · 0 lines"]);
  expect(await steps("kimi-tools", "kimi")).toEqual(["start Bash(ls)", "start Write(oi.txt)", "end Bash(ls) ✓ 2 lines", "end Write(oi.txt) ✓ 1 line"]);
});

test("agy: a refused command is a refused step; a run that ended at a refusal is not an answer", async () => {
  // plan mode's deny rule: the command is refused, the model hears why and goes on
  const ended: AgentToolEvent[] = [];
  const r = await harness("agy-denied", { format: "antigravity" }).chat({ messages: ask, onAgentTool: (e) => e.phase === "end" && ended.push(e) });
  expect(r.final).toBe("feito");
  expect(ended).toMatchObject([{ label: "Bash(git log --oneline -3)", ok: false, refused: true, summary: "refused" }]);
  expect(ended[0]!.output).toContain("Matches user-configured deny rule");
  // no rule for it: agy refused, ended the run as a success, and all it said was what it would do
  await expect(harness("agy-asks", { format: "antigravity" }).chat({ messages: ask })).rejects.toMatchObject({
    message: "stopped at a refused permission (RunCommand): agy ends the run there",
    afterText: true,
  });
  // plan mode and isolated carry the rule; as an agent it runs its commands
  for (const mode of ["plan", "isolated"] as const) {
    const args = CLI_PRESETS.agy!.modes[mode];
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ permissions: { deny: ["command(*)", "mcp(*)", "read_url(*)", "execute_url(*)"] } });
  }
  expect(CLI_PRESETS.agy!.modes.agent).not.toContain("--settings");
  // an MCP tool shows its server, its tool and what it asked, as in Claude Code
  const mcp = { id: "agy_5", name: "call_mcp_tool", input: { ServerName: "qdrant-rag", ToolName: "search_rag", Arguments: { query: "stackbuilder" } } };
  expect(agentTool({ phase: "end", ...mcp, ok: false, refused: true })).toEqual({ name: "qdrant-rag - search_rag (MCP)", label: "qdrant-rag - search_rag (MCP)(stackbuilder)", summary: "refused" });
  expect(agentTool({ phase: "start", ...mcp }).label).toBe("qdrant-rag - search_rag (MCP)(stackbuilder)");
});

test("a CLI's last message is the text after its last tool; the text keeps all it said, for the screen", async () => {
  const run = async (mode: string, format: NonNullable<HarnessProviderConfig["format"]>) => {
    let streamed = "";
    const r = await harness(mode, { format }).chat({ messages: ask, onDelta: (t) => (streamed += t), onAgentTool: () => {} });
    expect(streamed).toBe(r.text);
    return r;
  };
  // Claude Code's result is its last message already; agy's response is the whole text, so the steps decide
  expect(await run("claude-narrates", "claude")).toMatchObject({ text: "Vou listar os arquivos.São 2 arquivos .txt.\n\nFINAL: 2", final: "São 2 arquivos .txt.\n\nFINAL: 2" });
  expect(await run("agy-narrates", "antigravity")).toMatchObject({ text: "Vou listar os arquivos.\n\nExistem 2 arquivos .txt.\n\nFINAL: 2", final: "Existem 2 arquivos .txt.\n\nFINAL: 2" });
  expect(await run("kimi-narrates", "kimi")).toMatchObject({ final: "There are 2 .txt files.\n\nFINAL: 2" });
  expect(await run("opencode-narrates", "opencode")).toMatchObject({ text: "Vou listar.São 2.", final: "São 2." });
  // ended on a tool: the message before it
  expect((await run("ends-on-tool", "opencode")).final).toBe("A revisão: o csv.py quebra com 0x81.");
  // no tool, or nothing said before the first: the text is the message
  expect((await run("claude", "claude")).final).toBeUndefined();
  expect((await run("agy-tools", "antigravity")).final).toBeUndefined();
  expect(lastMessage("só isto", [0, 0])).toBeUndefined();
  expect(lastMessage("antes depois", [6])).toBe("depois");
  expect(lastMessage("antes ", [6])).toBeUndefined();
});

test("no clock stops a CLI: it answers however long it takes", async () => {
  const slow = new HarnessProvider("slow", { type: "harness", command: "sh", model: "x", args: ["-c", "sleep 1.5; echo done"], format: "text" });
  expect((await slow.chat({ messages: ask })).text).toBe("done");
});

test("Esc stops a CLI with what it started: a command of its own does not keep the answer waiting", async () => {
  const slow = new HarnessProvider("slow", { type: "harness", command: "sh", model: "x", args: ["-c", "echo started; sleep 30; echo never"], format: "text" });
  const esc = new AbortController();
  setTimeout(() => esc.abort(), 500);
  const started = performance.now();
  await expect(slow.chat({ messages: ask, signal: esc.signal })).rejects.toThrow("interrupted");
  expect(performance.now() - started).toBeLessThan(5000);
});
