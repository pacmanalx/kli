import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { resolveRef } from "../src/core/locations.ts";
import { stackProblems } from "../src/core/stack.ts";

const root = join(import.meta.dir, "..");
const files = ["kli.example.json", ...readdirSync(join(root, "examples")).filter((f) => f.endsWith(".json")).map((f) => `examples/${f}`)];

test.each(files)("%s loads as it is, and every model its stacks name is in it", (file) => {
  const config = loadConfig(join(root, file));
  const stacks = Object.entries(config.stacks ?? {});
  expect(stacks.length).toBeGreaterThan(0);
  for (const [name, stack] of stacks) {
    expect(stackProblems(name, stack)).toEqual([]);
    for (const node of Object.values(stack.nodes)) if (node.model) expect(() => resolveRef(config, node.model!)).not.toThrow();
  }
});
