import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setModel } from "../src/core/config.ts";
import { Core } from "../src/core/index.ts";
import type { Config } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-default-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = {
  locations: {
    aron: { type: "machine", ssh: "aron", providers: { "llama.cpp": { type: "server", port: 8080, tunnel: true, model: "qwen" } } },
    vertex: { type: "google", project: "p", model: "gemini-3.5-flash-lite" },
  },
  model: "aron/llama.cpp/qwen",
};

test("the model chosen is the default from then on: in the file, for the next session", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const core = new Core(loadConfig(path), path);
  expect(core.setDefaultModel("vertex/gemini-4-argon")).toBe("vertex/google/gemini-4-argon");
  expect(core.defaultModel()).toBe("vertex/google/gemini-4-argon");
  // a new session, as after leaving and coming back
  expect(new Core(loadConfig(path), path).defaultModel()).toBe("vertex/google/gemini-4-argon");
  expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).model).toBe("aron/llama.cpp/qwen");
});

test("a model the config does not have is refused", () => {
  expect(() => setModel(config, "nowhere/x")).toThrow(/not declared/);
  expect(setModel(config, "aron").model).toBe("aron/llama.cpp/qwen");
});
