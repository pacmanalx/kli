import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/core/config.ts";
import type { FormField } from "../src/cli/form.ts";
import { changeLocationKind, changeProviderKind, locationForm, providerForm, readLocation, readMachineProvider } from "../src/cli/location-form.ts";

// no real ~/.kli/.env in these tests
const dir = mkdtempSync(join(tmpdir(), "kli-forms-"));
beforeAll(() => (process.env.KLI_ENV = join(dir, ".env")));
afterAll(() => {
  delete process.env.KLI_ENV;
  rmSync(dir, { recursive: true, force: true });
});

const config = () =>
  validateConfig({
    locations: {
      mac: {
        type: "machine",
        providers: {
          ollama: { type: "server", port: 11434, path: "/v1", model: "lfm3", extra: { reasoning_effort: "none" } },
          "claude-agent": { type: "cli", command: "claude", cwd: ".", args: ["-p", "--tools", "Read", "", "--model", "{model}"], model: "sonnet" },
        },
      },
      vertex: { type: "google", project: "p", region: "global", maxTokens: 8192 },
    },
  });
const set = (fields: FormField[], key: string, v: string) => {
  const f = fields.find((x) => x.key === key)!;
  if (f.type !== "checks") f.value = v;
};

test("a new location starts as another machine, which needs an address or ssh", () => {
  const d = locationForm(config());
  set(d.form.fields, "name", "gibbor");
  expect(() => readLocation(d)).toThrow(/Address or SSH/);
  set(d.form.fields, "ssh", "admin@192.168.10.230");
  set(d.form.fields, "jump", "aron");
  expect(readLocation(d)).toEqual({ name: "gibbor", location: { type: "machine", providers: {}, ssh: "admin@192.168.10.230", jump: "aron" }, key: undefined });
});

test("an API: the key goes to its variable, the config only names it", () => {
  const d = locationForm(config());
  set(d.form.fields, "name", "openrouter");
  set(d.form.fields, "kind", "api");
  changeLocationKind(d);
  set(d.form.fields, "url", "https://openrouter.ai/api/v1");
  set(d.form.fields, "key", "sk-or-1");
  expect(readLocation(d)).toEqual({
    name: "openrouter",
    location: { type: "api", url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
    key: { env: "OPENROUTER_API_KEY", value: "sk-or-1" },
  });
  // Anthropic's usual variable is the default, so it is not written
  set(d.form.fields, "kind", "anthropic");
  changeLocationKind(d);
  set(d.form.fields, "key", "sk-ant");
  expect(readLocation(d).location).toEqual({ type: "anthropic" });
});

test("editing Google keeps what the form does not show; with no key it uses gcloud's login", () => {
  const d = locationForm(config(), "vertex");
  set(d.form.fields, "model", "gemini-3.5-flash");
  expect(readLocation(d).location).toEqual({ type: "google", project: "p", region: "global", maxTokens: 8192, model: "gemini-3.5-flash" });
  set(d.form.fields, "key", "AIza-1");
  expect(readLocation(d)).toMatchObject({ location: { apiKeyEnv: "GOOGLE_API_KEY" }, key: { env: "GOOGLE_API_KEY", value: "AIza-1" } });
});

test("a machine's provider: a server keeps its extras; a CLI keeps its own arguments unless they are cleared", () => {
  const server = providerForm(config(), "mac", "ollama");
  set(server.form.fields, "model", "qwen3:14b");
  expect(readMachineProvider(server).provider).toEqual({ type: "server", port: 11434, path: "/v1", model: "qwen3:14b", extra: { reasoning_effort: "none" } });

  const agent = providerForm(config(), "mac", "claude-agent");
  expect(readMachineProvider(agent).provider).toEqual({ type: "cli", command: "claude", cwd: ".", args: ["-p", "--tools", "Read", "", "--model", "{model}"], model: "sonnet" });
  set(agent.form.fields, "args", "");
  expect(readMachineProvider(agent).provider).toEqual({ type: "cli", command: "claude", cwd: ".", model: "sonnet" });

  const fresh = providerForm(config(), "mac");
  set(fresh.form.fields, "kind", "cli");
  changeProviderKind(fresh, false);
  set(fresh.form.fields, "name", "kimi");
  set(fresh.form.fields, "command", "kimi");
  expect(readMachineProvider(fresh)).toEqual({ name: "kimi", provider: { type: "cli", command: "kimi" } });
});
