import { expect, test } from "bun:test";
import { validateConfig } from "../src/core/config.ts";
import { ConfigError } from "../src/core/types.ts";

const base = () => ({
  locations: {
    mac: { type: "machine", providers: { ollama: { type: "server", port: 11434, model: "lfm3" } } },
    vertex: { type: "google", project: "p" },
  },
  model: "mac/ollama/lfm3",
  fallback: ["vertex/gemini-3.5-flash"],
});

test("a valid config passes", () => {
  expect(validateConfig(base()).model).toBe("mac/ollama/lfm3");
});

test("a model or a fallback that names nothing is rejected", () => {
  const c = base();
  c.fallback = ["mac/nope/x"];
  expect(() => validateConfig(c)).toThrow(/fallback "mac\/nope\/x": mac has no provider "nope"/);
});

test("a config from before locations says so", () => {
  expect(() => validateConfig({ providers: {}, profiles: {} })).toThrow(/before locations/);
});

test("reports every problem at once", () => {
  const c = {
    locations: {
      a: { type: "bedrock" },
      g: { type: "google" },
      api: { type: "api" },
      m: { type: "machine", providers: { s: { type: "server" }, c: { type: "cli" }, t: { type: "server", port: 1, tunnel: true } } },
    },
  };
  try {
    validateConfig(c);
    throw new Error("should have failed");
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const m = (e as Error).message;
    for (const part of ['type "bedrock"', 'location "g": missing "project"', 'location "api": missing "url"', 'provider "m/s": missing "port"', 'provider "m/c": missing "command"', 'provider "m/t": a tunnel needs'])
      expect(m).toContain(part);
  }
});
