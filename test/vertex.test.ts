import { afterAll, expect, test } from "bun:test";
import { GoogleAuth } from "../src/core/providers/google-auth.ts";
import { VertexProvider } from "../src/core/providers/vertex.ts";

type Seen = { path: string; headers: Record<string, string>; body: any };
const seen: Seen[] = [];
const sse = (items: object[]) => items.map((i) => `data: ${JSON.stringify(i)}\r\n\r\n`).join("");
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.json() });
    if (url.pathname.endsWith(":streamGenerateContent")) {
      if (url.pathname.includes("models/missing")) return Response.json({ error: { code: 404, message: "Publisher model not found" } }, { status: 404 });
      return new Response(
        sse([
          { candidates: [{ content: { role: "model", parts: [{ text: "pensando...", thought: true }] } }] },
          { candidates: [{ content: { role: "model", parts: [{ text: "Can" }] } }] },
          { candidates: [{ content: { role: "model", parts: [{ text: "berra." }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 5 } },
        ]),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return new Response(sse([{ choices: [{ delta: { content: "olá" } }] }, { choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } }]) + "data: [DONE]\n\n");
  },
});
afterAll(() => server.stop(true));

const auth = { headers: async () => ({ Authorization: "Bearer fake", "x-goog-user-project": "quota-x" }) } as unknown as GoogleAuth;
const vertex = (model: string, location = "global") =>
  new VertexProvider("gemini", { type: "vertex", project: "proj", location, model, url: server.url.origin, maxTokens: 100, extra: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } } }, auth);

test("google/* uses the native Gemini API: system instruction, roles, thinking left out, usage", async () => {
  const deltas: string[] = [];
  const r = await vertex("google/gemini-2.5-flash-lite").chat({
    messages: [
      { role: "system", content: "Seja breve." },
      { role: "user", content: "Capital da Austrália?" },
      { role: "assistant", content: "Pergunte." },
      { role: "user", content: "Agora." },
    ],
    temperature: 0.2,
    onDelta: (t) => deltas.push(t),
  });
  expect(r).toEqual({ text: "Canberra.", inputTokens: 9, outputTokens: 8, thinkingTokens: 5 });
  expect(deltas).toEqual(["Can", "berra."]);
  const s = seen.at(-1)!;
  expect(s.path).toBe("/v1/projects/proj/locations/global/publishers/google/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse");
  expect(s.headers.authorization).toBe("Bearer fake");
  expect(s.headers["x-goog-user-project"]).toBe("quota-x");
  expect(s.body.systemInstruction).toEqual({ parts: [{ text: "Seja breve." }] });
  expect(s.body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
  expect(s.body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 }, temperature: 0.2, maxOutputTokens: 100 });
  // one call can cap its answer below the location's
  await vertex("google/gemini-2.5-flash-lite").chat({ messages: [{ role: "user", content: "Agora." }], maxTokens: 32 });
  expect(seen.at(-1)!.body.generationConfig.maxOutputTokens).toBe(32);
});

test("other publishers use Vertex's OpenAI-compatible endpoint with the Google token", async () => {
  const r = await vertex("deepseek-ai/deepseek-v3.2-maas", "us-central1").chat({ messages: [{ role: "user", content: "oi" }] });
  expect(r).toEqual({ text: "olá", inputTokens: 4, outputTokens: 1 });
  const s = seen.at(-1)!;
  expect(s.path).toBe("/v1/projects/proj/locations/us-central1/endpoints/openapi/chat/completions");
  expect(s.headers.authorization).toBe("Bearer fake");
  expect(s.body.model).toBe("deepseek-ai/deepseek-v3.2-maas");
});

test("a Vertex error message comes through", async () => {
  await expect(vertex("google/missing").chat({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({
    status: 404,
    message: "HTTP 404: Publisher model not found",
  });
});
