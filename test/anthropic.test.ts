import { afterAll, beforeAll, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/core/providers/anthropic.ts";

let seen: { headers: Record<string, string>; body: any } | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen = { headers: Object.fromEntries(req.headers), body: await req.json() };
    const events = [
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 11 } } }],
      ["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "Can" } }],
      ["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "berra." } }],
      ["message_delta", { type: "message_delta", usage: { output_tokens: 4 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  },
});
beforeAll(() => (process.env.KLI_TEST_ANTHROPIC = "sk-test"));
afterAll(() => server.stop(true));

test("Messages API: system goes apart, max_tokens is set, the text streams and tokens are counted", async () => {
  const p = new AnthropicProvider("claude", { type: "anthropic", model: "claude-sonnet-5-5", apiKeyEnv: "KLI_TEST_ANTHROPIC", url: server.url.origin });
  const r = await p.chat({ messages: [{ role: "system", content: "Seja breve." }, { role: "user", content: "Capital?" }], temperature: 0 });
  expect(r).toEqual({ text: "Canberra.", inputTokens: 11, outputTokens: 4 });
  expect(seen!.headers["x-api-key"]).toBe("sk-test");
  expect(seen!.headers["anthropic-version"]).toBe("2023-06-01");
  expect(seen!.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 4096, system: "Seja breve.", stream: true, temperature: 0, messages: [{ role: "user", content: "Capital?" }] });
  // one call can cap its answer below the config's
  await p.chat({ messages: [{ role: "user", content: "Capital?" }], maxTokens: 32 });
  expect(seen!.body).toMatchObject({ max_tokens: 32 });
});

test("without the key it says which variable to set", async () => {
  const p = new AnthropicProvider("claude", { type: "anthropic", model: "m", apiKeyEnv: "KLI_TEST_NOPE" });
  await expect(p.chat({ messages: [] })).rejects.toThrow("missing API key: put KLI_TEST_NOPE in");
});
