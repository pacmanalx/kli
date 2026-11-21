import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, putLocation, putProvider, removeLocation, removeProvider, saveConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/types.ts";

const config: Config = {
  locations: {
    mac: { type: "machine", providers: { ollama: { type: "server", port: 11434, model: "lfm3" }, agy: { type: "cli", command: "agy" } } },
    gibbor: { type: "machine", ssh: "admin@192.168.10.230", providers: { ollama: { type: "server", port: 11435, tunnel: true, model: "lfm3" } } },
  },
  model: "gibbor/ollama/lfm3",
  fallback: ["mac/ollama/lfm3", "mac/agy"],
};

test("renaming a location or a provider takes the model and the fallback along", () => {
  const renamed = putLocation(config, "box", config.locations.gibbor!, "gibbor");
  expect(Object.keys(renamed.locations)).toEqual(["mac", "box"]); // same place in the list
  expect(renamed.model).toBe("box/ollama/lfm3");
  const p = putProvider(config, "mac", "antigravity", { type: "cli", command: "agy" }, "agy");
  expect(p.fallback).toEqual(["mac/ollama/lfm3", "mac/antigravity"]);
});

test("a name already taken is refused", () => {
  expect(() => putLocation(config, "mac", { type: "machine", providers: {} })).toThrow(/already exists/);
  expect(() => putProvider(config, "mac", "agy", { type: "cli", command: "claude" })).toThrow(/already has/);
});

test("deleting stops the model and the fallback from pointing there", () => {
  const { config: c, changed } = removeLocation(config, "gibbor");
  expect(c.model).toBeUndefined();
  expect(changed).toEqual(["model gibbor/ollama/lfm3 removed"]);
  const r = removeProvider(config, "mac", "agy");
  expect(r.config.fallback).toEqual(["mac/ollama/lfm3"]);
  expect(r.changed).toEqual(["left the fallback"]);
});

test("saving keeps the previous file next to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "kli-save-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  saveConfig(path, putLocation(config, "vertex", { type: "google", project: "p", model: "gemini-3.5-flash" }));
  expect(Object.keys(loadConfig(path).locations)).toContain("vertex");
  expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).locations.vertex).toBeUndefined();
});
