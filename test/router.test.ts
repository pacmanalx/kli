import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../src/core/providers/provider.ts";
import { Router } from "../src/core/router.ts";
import { readTrace, Trace } from "../src/core/trace.ts";
import { ConfigError, ProviderError, type Config } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = {
  locations: {
    desk: { type: "machine", host: "desk", providers: { "llama.cpp": { type: "server", port: 8080, model: "qwen" } } },
    mac: { type: "machine", providers: { ollama: { type: "server", port: 11434, model: "lfm3" }, claude: { type: "cli", command: "claude", model: "sonnet" } } },
    vertex: { type: "google", project: "p", model: "gemini-3.5-flash-lite" },
  },
  model: "desk/llama.cpp/qwen",
  fallback: ["mac/ollama/lfm3"],
};

type Behavior = "answers" | "fails-before" | "fails-after";
function router(behavior: Record<string, Behavior>) {
  return new Router(config, (name, cfg): Provider => ({
    name,
    model: cfg.model,
    async chat({ onDelta }) {
      const b = behavior[`${name}/${cfg.model}`];
      if (b === "fails-before") throw new ProviderError(name, "cannot connect");
      onDelta?.("hi");
      if (b === "fails-after") throw new ProviderError(name, "dropped mid-answer", true);
      return { text: `hi from ${name}`, inputTokens: 3, outputTokens: 2 };
    },
  }));
}
const trace = () => new Trace(dir, { user: "test", surface: "test" });
const messages = [{ role: "user" as const, content: "hi" }];
const types = (t: Trace) => readTrace(dir, t.id).map((e) => e.type);

test("the config's model answers: no fallback", async () => {
  const r = await router({ "desk/llama.cpp/qwen": "answers" }).chat(messages, {}, trace());
  expect(r).toMatchObject({ provider: "desk/llama.cpp", model: "qwen", ref: "desk/llama.cpp/qwen", text: "hi from desk/llama.cpp" });
  expect(r.fallback).toBeUndefined();
});

test("it fails before any text: the fallback answers, and the trace shows it", async () => {
  const t = trace();
  const r = await router({ "desk/llama.cpp/qwen": "fails-before", "mac/ollama/lfm3": "answers" }).chat(messages, {}, t);
  expect(r).toMatchObject({ ref: "mac/ollama/lfm3", fallback: { from: "desk/llama.cpp/qwen", reason: "cannot connect", failed: [{ provider: "desk/llama.cpp/qwen" }] } });
  expect(types(t)).toEqual(["start", "request", "failure", "fallback", "request", "response"]);
  expect(readTrace(dir, t.id).find((e) => e.type === "failure")).toMatchObject({ provider: "desk/llama.cpp", model: "qwen" });
});

test("it fails after the answer started: no fallback", async () => {
  const p = router({ "desk/llama.cpp/qwen": "fails-after", "mac/ollama/lfm3": "answers" }).chat(messages, {}, trace());
  await expect(p).rejects.toMatchObject({ provider: "desk/llama.cpp", afterText: true });
});

test("user interrupted: no fallback, recorded as interrupted", async () => {
  const controller = new AbortController();
  controller.abort();
  const t = trace();
  const p = router({ "desk/llama.cpp/qwen": "fails-before" }).chat(messages, { signal: controller.signal }, t);
  await expect(p).rejects.toMatchObject({ provider: "desk/llama.cpp" });
  expect(types(t)).toEqual(["start", "request", "interrupted"]);
});

test("a session with no events leaves no file", () => {
  const t = trace();
  expect(readTrace(dir, t.id)).toEqual([]);
  t.record({ type: "prompt", content: "hi" });
  expect(types(t)).toEqual(["start", "prompt"]);
});

test("a chosen model goes first and the fallback still covers it", async () => {
  const r = await router({ "vertex/google/gemini-4": "fails-before", "mac/ollama/lfm3": "answers" }).chat(messages, { model: "vertex/gemini-4" }, trace());
  expect(r).toMatchObject({ ref: "mac/ollama/lfm3", fallback: { from: "vertex/google/gemini-4" } });
});

test("choosing the fallback itself leaves no fallback; a model the config does not have is refused", async () => {
  await expect(router({ "mac/ollama/lfm3": "fails-before" }).chat(messages, { model: "mac/ollama/lfm3" }, trace())).rejects.toMatchObject({ provider: "mac/ollama" });
  await expect(router({}).chat(messages, { model: "nowhere/x" }, trace())).rejects.toThrow(ConfigError);
});

test("names: defaults fill what is left out", () => {
  const r = router({});
  expect(r.target("mac/ollama").ref).toBe("mac/ollama/lfm3");
  expect(r.target("desk").ref).toBe("desk/llama.cpp/qwen"); // its only provider
  expect(r.target("vertex").ref).toBe("vertex/google/gemini-3.5-flash-lite");
  expect(r.target("vertex/deepseek-ai/deepseek-v4.1-flash-maas")).toMatchObject({ label: "vertex", provider: "deepseek-ai", model: "deepseek-ai/deepseek-v4.1-flash-maas" });
  expect(r.target("mac/ollama/qwen3:14b")).toMatchObject({ label: "mac/ollama", model: "qwen3:14b" });
  expect(() => r.target("mac")).toThrow(/say which/);
  expect(() => r.target("mac/nope")).toThrow(/no provider "nope"/);
});
