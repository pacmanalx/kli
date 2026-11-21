import { expect, test } from "bun:test";
import { validateConfig } from "../src/core/config.ts";
import { stackProblems } from "../src/core/stack.ts";
import { starterConfig, starterStacks, type Found } from "../src/core/starter.ts";

const found = (over: Partial<Found> = {}): Found => ({ servers: [], clis: [], keys: [], ...over });

/** What `kli init` writes must load as it is, and every stack must have a valid shape. */
function valid(f: Found) {
  const config = validateConfig(starterConfig(f));
  for (const [name, stack] of Object.entries(config.stacks ?? {})) expect(stackProblems(name, stack)).toEqual([]);
  return config;
}

test("Claude Code and an Ollama model: the stacks put the CLI next to the local model, and the CLI judges", () => {
  const c = valid(found({ clis: ["claude"], servers: [{ name: "ollama", port: 11434, models: ["qwen3:4b"] }] }));
  expect(c.model).toBe("local/claude/sonnet");
  expect(c.locations.local).toEqual({
    type: "machine",
    providers: { claude: { type: "cli", command: "claude", model: "sonnet" }, ollama: { type: "server", port: 11434, model: "qwen3:4b" } },
  });
  expect(Object.keys(c.stacks!)).toEqual(["compare", "review", "choose"]);
  expect(c.stacks!.compare!.nodes).toEqual({ sonnet: { model: "local/claude/sonnet" }, "qwen3-4b": { model: "local/ollama/qwen3:4b" } });
  expect(c.stacks!.review!.nodes.judge).toEqual({ model: "local/claude/sonnet", role: "verify", from: ["join", "sonnet", "qwen3-4b"] });
  expect(c.stacks!.choose!.nodes.choice!.by).toEqual(["person", "model"]);
});

test("two CLIs make the agents stack: each writes in its own copy and the strongest judges", () => {
  const c = valid(found({ clis: ["claude", "agy"] }));
  expect(c.stacks!.agents!.nodes).toEqual({
    sonnet: { model: "local/claude/sonnet", tools: "write" },
    agy: { model: "local/agy", tools: "write" },
    judge: { model: "local/claude/sonnet", role: "verify", from: ["sonnet", "agy"] },
  });
});

test("Ollama alone with two models compares them; with one model there is no stack, and the config still loads", () => {
  const two = valid(found({ servers: [{ name: "ollama", port: 11434, models: ["qwen3:4b", "gemma3:4b"] }] }));
  expect(two.model).toBe("local/ollama/qwen3:4b");
  expect(Object.values(two.stacks!.compare!.nodes).map((n) => n.model)).toEqual(["local/ollama/qwen3:4b", "local/ollama/gemma3:4b"]);
  expect(two.stacks!.agents).toBeUndefined();
  const one = valid(found({ servers: [{ name: "ollama", port: 11434, models: ["qwen3:4b"] }] }));
  expect(one.stacks).toBeUndefined();
  expect(one.model).toBe("local/ollama/qwen3:4b");
});

test("Claude Code alone still compares: its smaller model is the second voice", () => {
  const c = valid(found({ clis: ["claude"] }));
  expect(Object.values(c.stacks!.compare!.nodes).map((n) => n.model)).toEqual(["local/claude/sonnet", "local/claude/haiku"]);
});

test("an API key adds its location; only Anthropic gets a model and enters the stacks", () => {
  const c = valid(found({ keys: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"], servers: [{ name: "ollama", port: 11434, models: ["qwen3:4b"] }] }));
  expect(c.locations.anthropic).toEqual({ type: "anthropic", model: "claude-sonnet-5-5" });
  expect(c.locations.openrouter).toEqual({ type: "api", url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" });
  expect(c.model).toBe("anthropic/claude-sonnet-5-5");
  expect(Object.values(c.stacks!.compare!.nodes).map((n) => n.model)).toEqual(["anthropic/claude-sonnet-5-5", "local/ollama/qwen3:4b"]);
});

test("node names come from the models, valid and never repeated", () => {
  const stacks = starterStacks(found({ servers: [{ name: "ollama", port: 11434, models: ["Judge:7B"] }, { name: "lmstudio", port: 1234, models: ["judge:7b"] }] }));
  expect(Object.keys(stacks.review!.nodes)).toEqual(["judge-7b", "judge-7b-2", "join", "judge"]);
});

test("nothing found: no locations, no model, no stacks", () => {
  const c = starterConfig(found());
  expect(c.locations).toEqual({});
  expect(c.model).toBeUndefined();
  expect(c.stacks).toBeUndefined();
});
