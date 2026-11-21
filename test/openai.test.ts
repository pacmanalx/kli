import { afterAll, expect, test } from "bun:test";
import { OpenAIProvider } from "../src/core/providers/openai.ts";
import { ProviderError } from "../src/core/types.ts";

let receivedBody: Record<string, unknown> = {};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    receivedBody = (await req.json()) as Record<string, unknown>;
    if (url.pathname === "/error/v1/chat/completions") return new Response("model not loaded", { status: 503 });
    const lines = [
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
