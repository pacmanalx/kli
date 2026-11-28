import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider, anthropicMessages } from "../src/core/providers/anthropic.ts";
import { OpenAIProvider, openaiMessages } from "../src/core/providers/openai.ts";
import type { ChatRequest, Provider } from "../src/core/providers/provider.ts";
import { geminiContents, VertexProvider } from "../src/core/providers/vertex.ts";
import { Router } from "../src/core/router.ts";
import { Session } from "../src/core/session.ts";
import { Workspace } from "../src/core/tools.ts";
import { readTrace, Trace } from "../src/core/trace.ts";
import type { Config, Message } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-agent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = { locations: { mac: { type: "machine", providers: { ollama: { type: "server", port: 1, model: "m" } } } }, model: "mac/ollama/m" };

/** A model that asks for the given tool calls, one turn each, then answers. */
function scripted(turns: { text?: string; toolCalls?: { name: string; input: Record<string, unknown> }[] }[]) {
  const seen: ChatRequest[] = [];
  const router = new Router(config, (name, cfg): Provider => ({
    name,
    model: cfg.model,
    async chat(request) {
      seen.push({ ...request, messages: [...request.messages] });
      const turn = turns.shift() ?? { text: "done" };
      if (turn.text) request.onDelta?.(turn.text);
      return { text: turn.text ?? "", ...(turn.toolCalls && { toolCalls: turn.toolCalls.map((c, i) => ({ id: `c${seen.length}-${i}`, ...c })) }) };
    },
  }));
  return { router, seen };
}

test("the loop: the model asks for a tool, gets its result, and answers; the trace has the tool", async () => {
  const root = mkdtempSync(join(dir, "w-"));
  const ws = new Workspace(root);
  ws.ask = async () => "yes";
  const { router, seen } = scripted([{ text: "Vou criar.", toolCalls: [{ name: "Write", input: { file_path: "a.py", content: "print(1)\n" } }] }, { text: "Criei a.py." }]);
  const trace = new Trace(dir, { user: "t", surface: "test" });
  const tools: string[] = [];
  const r = await new Session(router, trace, "Be brief.", ws).send("crie a.py", { onTool: (e) => tools.push(`${e.phase} ${e.label}`) });
  expect(r).toMatchObject({ text: "Criei a.py.", steps: 2 });
  expect(readFileSync(join(root, "a.py"), "utf8")).toBe("print(1)\n");
  expect(tools).toEqual(["start Write(a.py)", "end Write(a.py)"]);
  // the model was offered the tools, and saw its call and the result on the second turn
  expect(seen[0]!.tools!.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "BashOutput", "KillBash"]);
  expect(seen[0]!.messages[0]!.content).toContain(`Working directory: ${root}`);
  expect(seen[1]!.messages.slice(-2).map((m) => m.role)).toEqual(["assistant", "tool"]);
  expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "tool", toolName: "Write", content: "Created a.py (1 line)" });
  expect(readTrace(dir, trace.id).find((e) => e.type === "tool")).toMatchObject({ name: "Write", detail: "Write(a.py)", ok: true });
});

test("a refusal stops the turn; the other calls of that turn are answered as not run", async () => {
  const root = mkdtempSync(join(dir, "w-"));
  const ws = new Workspace(root);
  ws.ask = async () => "no";
  const { router, seen } = scripted([
    { toolCalls: [{ name: "Bash", input: { command: "rm -rf x" } }, { name: "Read", input: { file_path: "y" } }] },
    { text: "never" },
  ]);
  const session = new Session(router, new Trace(dir, { user: "t", surface: "test" }), undefined, ws);
  const r = await session.send("apague tudo");
  expect(r.notice).toContain("you refused a tool");
  expect(seen.length).toBe(1);
  // the next prompt carries both answers, so every call the model made has its result
  await session.send("ok, nada");
  const results = seen[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content);
  expect(results).toEqual(["The person refused this action. Stop and wait for their instructions.", "Not run: the person stopped this turn."]);
  expect(existsSync(join(root, "x"))).toBe(false);
});

// how each provider writes the same conversation with a tool call and its result
const conversation: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "leia a.txt" },
  { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "Read", input: { file_path: "a.txt" } }, { id: "t2", name: "Glob", input: { pattern: "*" } }] },
  { role: "tool", content: "1\tum", toolCallId: "t1", toolName: "Read" },
  { role: "tool", content: "a.txt", toolCallId: "t2", toolName: "Glob" },
];

test("the formats: OpenAI tool messages, Anthropic tool_result blocks together, Gemini function responses together", () => {
  expect(openaiMessages(conversation).slice(2)).toEqual([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } },
        { id: "t2", type: "function", function: { name: "Glob", arguments: '{"pattern":"*"}' } },
      ],
    },
    { role: "tool", tool_call_id: "t1", content: "1\tum" },
    { role: "tool", tool_call_id: "t2", content: "a.txt" },
  ]);
  expect(anthropicMessages(conversation).slice(1)).toEqual([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }, { type: "tool_use", id: "t2", name: "Glob", input: { pattern: "*" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1\tum" }, { type: "tool_result", tool_use_id: "t2", content: "a.txt" }] },
  ]);
  const signed = [{ functionCall: { name: "Read", args: { file_path: "a.txt" } }, thoughtSignature: "sig" }];
  const gemini = geminiContents([...conversation.slice(0, 2), { ...conversation[2]!, raw: { provider: "gemini", parts: signed } }, ...conversation.slice(3)]);
  expect(gemini.slice(1)).toEqual([
    { role: "model", parts: signed }, // as it came, signature included
    { role: "user", parts: [{ functionResponse: { name: "Read", response: { content: "1\tum" } } }, { functionResponse: { name: "Glob", response: { content: "a.txt" } } }] },
  ]);
});

const sse = (items: object[], done = false) => items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
const bodies: any[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body: any = await req.json();
    bodies.push(body);
    if (path === "/notools/v1/chat/completions" && body.tools) return Response.json({ error: { message: "tools param requires --jinja flag" } }, { status: 400 });
    if (path.endsWith("/chat/completions"))
      return new Response(
        sse(
          [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "Rea", arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "d", arguments: '{"file_' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }] } }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
          ],
          true,
        ),
      );
    if (path === "/v1/messages")
      return new Response(
        sse([
          { type: "message_start", message: { usage: { input_tokens: 7 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Lendo." } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]),
      );
    return new Response(
      sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "hmm", thought: true }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "Read", args: { file_path: "a.txt" } }, thoughtSignature: "abc" }] } }] },
      ]),
    );
  },
});
afterAll(() => server.stop(true));
const ask = { messages: [{ role: "user" as const, content: "leia" }], tools: [{ name: "Read", description: "reads", parameters: { type: "object", properties: {} } }] };

test("OpenAI-compatible: the tools are offered and a call that comes in pieces is put together", async () => {
  const r = await new OpenAIProvider("x", { url: `${server.url}v1`, model: "m" }).chat(ask);
  expect(r.toolCalls).toEqual([{ id: "call_9", name: "Read", input: { file_path: "a.txt" } }]);
  expect(bodies.at(-1).tools).toEqual([{ type: "function", function: { name: "Read", description: "reads", parameters: { type: "object", properties: {} } } }]);
});

test("a server that refuses tools is asked again without them, and the answer says so", async () => {
  const p = new OpenAIProvider("desk/llama.cpp", { url: `${server.url}notools/v1`, model: "m" });
  const r = await p.chat(ask);
  expect(r.notice).toContain("does not take tools");
  expect(bodies.at(-1).tools).toBeUndefined();
  await p.chat(ask); // and from then on it is not offered them
  expect(bodies.at(-1).tools).toBeUndefined();
});

test("Anthropic: text and a tool_use whose input comes in pieces", async () => {
  process.env.KLI_TEST_ANTHROPIC = "k";
  try {
    const r = await new AnthropicProvider("anthropic", { type: "anthropic", url: `${server.url}`, apiKeyEnv: "KLI_TEST_ANTHROPIC", model: "m" }).chat(ask);
    expect(r).toMatchObject({ text: "Lendo.", inputTokens: 7, outputTokens: 9, toolCalls: [{ id: "toolu_1", name: "Read", input: { file_path: "a.txt" } }] });
    expect(bodies.at(-1).tools).toEqual([{ name: "Read", description: "reads", input_schema: { type: "object", properties: {} } }]);
  } finally {
    delete process.env.KLI_TEST_ANTHROPIC;
  }
});

test("Gemini: a function call keeps its thought signature, to go back as it came", async () => {
  process.env.KLI_TEST_GOOGLE = "k";
  try {
    const r = await new VertexProvider("vertex", { type: "vertex", project: "p", url: `${server.url}`, apiKeyEnv: "KLI_TEST_GOOGLE", model: "google/gemini-x" }).chat(ask);
    expect(r.toolCalls).toEqual([{ id: "gemini_0", name: "Read", input: { file_path: "a.txt" } }]);
    expect(r.raw).toEqual({ provider: "gemini", parts: [{ functionCall: { name: "Read", args: { file_path: "a.txt" } }, thoughtSignature: "abc" }] });
    expect(bodies.at(-1).tools).toEqual([{ functionDeclarations: [{ name: "Read", description: "reads", parameters: { type: "object", properties: {} } }] }]);
  } finally {
    delete process.env.KLI_TEST_GOOGLE;
  }
});

test("the loop has no limit of steps: a model that works in many small steps goes on until it answers", async () => {
  const root = mkdtempSync(join(dir, "w-"));
  const ws = new Workspace(root);
  // more looks than the 30 a conversation used to get, then the answer
  const looks = Array.from({ length: 60 }, () => ({ toolCalls: [{ name: "Glob", input: { pattern: "*" } }] }));
  const { router, seen } = scripted([...looks, { text: "found it" }]);
  const r = await new Session(router, new Trace(dir, { user: "t", surface: "test" }), undefined, ws).send("look");
  expect({ text: r.text, steps: r.steps }).toEqual({ text: "found it", steps: 61 });
  // never told to hurry
  expect(seen.some((s) => s.messages.some((m) => m.content.includes("left: finish now")))).toBe(false);
});

test("Esc stops the loop between two steps: the calls asked for are answered, and the turn stays out", async () => {
  const root = mkdtempSync(join(dir, "w-"));
  const ws = new Workspace(root);
  const { router } = scripted(Array.from({ length: 50 }, () => ({ toolCalls: [{ name: "Bash", input: { command: "sleep 0.05" } }] })));
  ws.mode = "acceptEdits";
  ws.rules.push({ words: ["sleep"], exact: false });
  const esc = new AbortController();
  setTimeout(() => esc.abort(), 300);
  const session = new Session(router, new Trace(dir, { user: "t", surface: "test" }), undefined, ws);
  await expect(session.send("wait", { signal: esc.signal })).rejects.toMatchObject({ name: "AbortError" });
  // the next prompt starts clean, from a conversation every provider takes
  const next = scripted([{ text: "ok" }]);
  (session as unknown as { router: Router }).router = next.router;
  await session.send("and now?");
  expect(next.seen[0]!.messages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user"]);
});
