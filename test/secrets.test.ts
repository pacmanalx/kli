import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileWarning, masked, saveSecret, secret, secretSource, withSecret } from "../src/core/secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.KLI_ENV;
  delete process.env.KLI_TEST_KEY;
});

test("the file is read like any .env, and the environment wins over it", () => {
  const path = join(dir, "a.env");
  writeFileSync(path, "# keys\nexport KLI_TEST_KEY='from-file'\nOTHER = \"two words\"\n\nbroken line\n");
  process.env.KLI_ENV = path;
  expect(secret("KLI_TEST_KEY")).toBe("from-file");
  expect(secret("OTHER")).toBe("two words");
  expect(secretSource("KLI_TEST_KEY")).toBe("file");
  process.env.KLI_TEST_KEY = "from-env";
  expect(secret("KLI_TEST_KEY")).toBe("from-env");
  expect(secretSource("KLI_TEST_KEY")).toBe("environment");
});

test("saving writes a file only its owner reads, replacing the old value; the key never reaches process.env", () => {
  const path = join(dir, "sub", "b.env");
  process.env.KLI_ENV = path;
  saveSecret("ANTHROPIC_API_KEY_TEST", "sk-1");
  saveSecret("GOOGLE_API_KEY_TEST", "g-1");
  saveSecret("ANTHROPIC_API_KEY_TEST", "sk-2");
  expect(readFileSync(path, "utf8")).toBe("ANTHROPIC_API_KEY_TEST=sk-2\nGOOGLE_API_KEY_TEST=g-1\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(secret("ANTHROPIC_API_KEY_TEST")).toBe("sk-2");
  expect(process.env.ANTHROPIC_API_KEY_TEST).toBeUndefined();
  expect(envFileWarning()).toBeUndefined();
});

test("a key typed and not saved serves while testing, then is gone; a readable file is warned about", async () => {
  process.env.KLI_ENV = join(dir, "c.env");
  expect(await withSecret("KLI_TEST_KEY", "typed", async () => secret("KLI_TEST_KEY"))).toBe("typed");
  expect(secret("KLI_TEST_KEY")).toBeUndefined();
  writeFileSync(process.env.KLI_ENV, "X=1\n", { mode: 0o644 });
  expect(envFileWarning()).toContain("chmod 600");
  expect(masked("sk-ant-abcd1234")).toBe("••••1234");
});
