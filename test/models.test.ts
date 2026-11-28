import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModels } from "../src/core/providers/models.ts";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/models")
      return Response.json({ data: [{ id: "lfm3:latest", owned_by: "library" }, { id: "/m/qwen.gguf", owned_by: "llamacpp", meta: { n_params: 7.6e9, size: 4.7e9, ftype: "Q4_K - Medium" } }] });
    if (path === "/v1beta1/publishers/google/models")
      return req.headers.get("x-goog-api-key") === "gk"
        ? Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-3.5-flash", launchStage: "GA" }, { name: "publishers/google/models/gemini-embedding-2" }, { name: "publishers/google/models/gemini-4-pro", launchStage: "PUBLIC_PREVIEW" }] })
        : new Response("no key", { status: 401 });
    if (path === "/v1beta1/publishers/deepseek-ai/models")
      return Response.json({ publisherModels: [{ name: "publishers/deepseek-ai/models/deepseek-v4.1-flash-maas", launchStage: "EXPERIMENTAL" }, { name: "publishers/deepseek-ai/models/deepseek-v4" }] });
    if (path === "/api/tags") return Response.json({ models: [{ name: "lfm3:latest", size: 1.1e9, details: { parameter_size: "1.7B", quantization_level: "Q4_K_M" } }] });
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop());

test("an OpenAI-compatible server lists its models, with Ollama's and llama.cpp's details", async () => {
  expect(await listModels({ type: "openai", url: `http://localhost:${server.port}/v1`, model: "x" })).toEqual([
    { id: "lfm3:latest", detail: "1.7B · Q4_K_M · 1.1 GB" },
    { id: "/m/qwen.gguf", detail: "7.6B · Q4_K - Medium · 4.7 GB" },
  ]);
  await expect(listModels({ type: "openai", url: "http://localhost:1/v1", model: "x" })).rejects.toThrow(/cannot connect/);
});

test("CLIs: Claude Code's aliases, `agy models` parsed, and a CLI without a list says so", async () => {
  expect((await listModels({ type: "harness", command: "claude", model: "sonnet" })).map((m) => m.id)).toEqual(["sonnet", "opus", "haiku", "fable"]);
  const dir = mkdtempSync(join(tmpdir(), "kli-agy-"));
  const agy = join(dir, "agy");
  writeFileSync(agy, "#!/bin/sh\necho 'Fetching available models...'\nprintf 'gemini-x-high\\tGemini X (High)\\ngemini-x-low\\tGemini X (Low)\\n'\n");
  chmodSync(agy, 0o755);
  expect(await listModels({ type: "harness", command: agy, model: "x" })).toEqual([
    { id: "gemini-x-high", detail: "Gemini X (High)" },
    { id: "gemini-x-low", detail: "Gemini X (Low)" },
  ]);
  await expect(listModels({ type: "harness", command: "my-cli", model: "x" })).rejects.toThrow(/no model list/);
});

test("Google: Gemini's chat models, GA first, and the partners' API models (-maas), with a key", async () => {
  process.env.KLI_TEST_GKEY = "gk";
  try {
    const models = await listModels({ type: "vertex", project: "p", url: `http://localhost:${server.port}`, apiKeyEnv: "KLI_TEST_GKEY", model: "x" });
    expect(models).toEqual([
      { id: "google/gemini-3.5-flash", detail: "ga" },
      { id: "google/gemini-4-pro", detail: "public preview" },
      { id: "deepseek-ai/deepseek-v4.1-flash-maas", detail: "experimental" },
    ]);
  } finally {
    delete process.env.KLI_TEST_GKEY;
  }
});

test("an exo cluster lists only what it has loaded, once, with the machines it is on", async () => {
  const { listModels } = await import("../src/core/providers/models.ts");
  const card = { quantization: "6bit", storageSize: { inBytes: 7_224_298_496 } };
  const nemotron = "mlx-community/NVIDIA-Nemotron-Nano-9B-v2-6bit";
  const instance = (nodes: string[]) => ({
    MlxRingInstance: {
      shardAssignments: {
        modelId: nemotron,
        nodeToRunner: Object.fromEntries(nodes.map((n, i) => [n, `r${n}${i}`])),
        runnerToShard: Object.fromEntries(nodes.map((n, i) => [`r${n}${i}`, { PipelineShardMetadata: { modelCard: card } }])),
      },
    },
  });
  let state = true;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/models")
        return Response.json({ data: [nemotron, "mlx-community/Qwen3.5-9B-8bit", "mlx-community/gemma-4-26b-a4b-it-6bit"].map((id) => ({ id, object: "model", owned_by: "exo" })) });
      if (path === "/state" && state)
        return Response.json({
          instances: { one: instance(["n1"]), two: instance(["n1", "n2", "n3"]) },
          nodeIdentities: { n1: { friendlyName: "node1" }, n2: { friendlyName: "node2" }, n3: { friendlyName: "node3" } },
        });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/v1`;
    expect(await listModels({ type: "openai", url, model: "" })).toEqual([{ id: nemotron, detail: "loaded on node1 + node2 + node3 · 6bit · 7.2 GB" }]);
    // the state cannot be read: the catalog as it came, rather than nothing
    state = false;
    expect((await listModels({ type: "openai", url, model: "" })).map((m) => m.id)).toEqual([nemotron, "mlx-community/Qwen3.5-9B-8bit", "mlx-community/gemma-4-26b-a4b-it-6bit"]);
  } finally {
    server.stop(true);
  }
});
