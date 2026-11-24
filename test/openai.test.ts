import { afterAll, expect, test } from "bun:test";
import { callsInText, OpenAIProvider } from "../src/core/providers/openai.ts";
import { ProviderError } from "../src/core/types.ts";

let receivedBody: Record<string, unknown> = {};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    receivedBody = (await req.json()) as Record<string, unknown>;
    if (url.pathname === "/error/v1/chat/completions") return new Response("model not loaded", { status: 503 });
    // a model that writes its tool call as text, in two pieces
    const written = url.pathname === "/written/v1/chat/completions";
    const lines = written ? [
      { choices: [{ delta: { content: '{"name": "Bash", ' } }] },
      { choices: [{ delta: { content: '"arguments": {"command": "bun test"}}' } }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } },
    ] : [
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: ", world" } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ];
    const body = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

test("reads the stream, joins the text, counts tokens and sends the extra fields", async () => {
  const p = new OpenAIProvider("fake", { type: "openai", url: `${server.url}v1/`, model: "m", extra: { reasoning_effort: "none" } });
  const deltas: string[] = [];
  const r = await p.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0, onDelta: (t) => deltas.push(t) });
  expect(r).toEqual({ text: "Hello, world", inputTokens: 12, outputTokens: 3 });
  expect(deltas).toEqual(["Hello", ", world"]);
  expect(receivedBody).toMatchObject({ model: "m", stream: true, temperature: 0, reasoning_effort: "none", messages: [{ role: "user", content: "hi" }] });
  expect(receivedBody).not.toHaveProperty("max_tokens");
  // one call can cap its answer (the triage reads one word)
  await p.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 32 });
  expect(receivedBody).toMatchObject({ max_tokens: 32 });
});

test("an HTTP error becomes a ProviderError with the status", async () => {
  const p = new OpenAIProvider("fake", { type: "openai", url: `${server.url}error/v1`, model: "m" });
  await expect(p.chat({ messages: [] })).rejects.toMatchObject({ status: 503, afterText: false });
});

test("nothing listening becomes a connection ProviderError", async () => {
  const p = new OpenAIProvider("dead", { type: "openai", url: "http://127.0.0.1:9/v1", model: "m" });
  const e = await p.chat({ messages: [] }).catch((x) => x);
  expect(e).toBeInstanceOf(ProviderError);
  expect(e.message).toContain("cannot connect");
});

test("a server's own instructions go at the end of the system message, or make one", async () => {
  const { openaiMessages } = await import("../src/core/providers/openai.ts");
  const { connectionNow } = await import("../src/core/locations.ts");
  const chat = [
    { role: "system" as const, content: "You are Kli." },
    { role: "user" as const, content: "oi" },
  ];
  expect(openaiMessages(chat, "/no_think")).toEqual([
    { role: "system", content: "You are Kli.\n\n/no_think" },
    { role: "user", content: "oi" },
  ]);
  expect(openaiMessages([{ role: "user", content: "oi" }], "/no_think")).toEqual([
    { role: "system", content: "/no_think" },
    { role: "user", content: "oi" },
  ]);
  expect(openaiMessages(chat)).toEqual(chat.map(({ role, content }) => ({ role, content })));
  // from the config to the provider: the exo cluster on another machine, reached directly
  const config = { locations: { rosh: { type: "machine" as const, host: "100.66.180.64", providers: { exo: { type: "server" as const, port: 52415, model: "mlx-community/NVIDIA-Nemotron-Nano-9B-v2-6bit", instructions: "/no_think" } } } } };
  expect(connectionNow(config, { ref: "rosh/exo/mlx-community/NVIDIA-Nemotron-Nano-9B-v2-6bit", location: "rosh", provider: "exo", model: "mlx-community/NVIDIA-Nemotron-Nano-9B-v2-6bit", label: "rosh/exo" })).toMatchObject({
    url: "http://100.66.180.64:52415/v1",
    instructions: "/no_think",
  });
});

test("a tool call written as text goes on as a call when the tool was offered; the screen hears it once", async () => {
  const p = new OpenAIProvider("fake", { type: "openai", url: `${server.url}written/v1`, model: "m" });
  const tools = [{ name: "Bash", description: "runs", parameters: { type: "object", properties: {} } }];
  const first = await p.chat({ messages: [{ role: "user", content: "test it" }], tools });
  expect(first).toEqual({
    text: "", inputTokens: 20, outputTokens: 9,
    toolCalls: [{ id: "call_0", name: "Bash", input: { command: "bun test" } }],
    notice: "fake: the model wrote its tool calls as text; Kli runs them as calls",
  });
  expect((await p.chat({ messages: [{ role: "user", content: "again" }], tools })).notice).toBeUndefined();
  // with no tools offered, the same text is an answer
  expect(await p.chat({ messages: [{ role: "user", content: "test it" }] })).toEqual({ text: '{"name": "Bash", "arguments": {"command": "bun test"}}', inputTokens: 20, outputTokens: 9 });
});

test("what counts as a call written as text: the whole answer, or each one in tool_call tags; anything else is an answer", () => {
  const offered = ["Bash", "Read"];
  const bash = { id: "call_0", name: "Bash", input: { command: "ls" } };
  expect(callsInText('{"name": "Bash", "arguments": {"command": "ls"}}', offered)).toEqual({ calls: [bash], text: "" });
  expect(callsInText('```json\n{"name": "Bash", "parameters": {"command": "ls"}}\n```', offered)).toEqual({ calls: [bash], text: "" });
  // arguments as a JSON string, as the API sends them
  expect(callsInText('{"name": "Bash", "arguments": "{\\"command\\": \\"ls\\"}"}', offered)).toEqual({ calls: [bash], text: "" });
  expect(callsInText('[{"name": "Bash", "arguments": {"command": "ls"}}, {"name": "Read", "arguments": {"file_path": "a.ts"}}]', offered)?.calls.map((c) => [c.id, c.name])).toEqual([["call_0", "Bash"], ["call_1", "Read"]]);
  // Qwen's tags, with text around them
  expect(callsInText('I will list it.\n<tool_call>\n{"name": "Bash", "arguments": {"command": "ls"}}\n</tool_call>', offered)).toEqual({ calls: [bash], text: "I will list it." });
  for (const answer of [
    "The tests pass.",
    'Run this: {"name": "Bash", "arguments": {"command": "ls"}}',
    '{"name": "Deploy", "arguments": {}}',
    '{"name": "Bash", "arguments": {"command": "ls"}, "why": "to see"}',
    '{"name": "Bash", "arguments": ["ls"]}',
    '{"name": "Bash", "arguments": {"command": "ls"}',
    '<tool_call>{"name": "Bash", "arguments": {"command": "ls"}</tool_call>',
    "",
  ])
    expect(callsInText(answer, offered)).toBeUndefined();
});
