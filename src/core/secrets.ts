import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * The API keys: from the environment, or from ~/.kli/.env ($KLI_ENV). The file's keys never go into process.env,
 * so the CLIs Kli runs do not get them (Claude Code would switch from the person's login to the paid API).
 */
export const envFile = (): string => process.env.KLI_ENV ?? join(homedir(), ".kli", ".env");
/** The file as people read it: ~/.kli/.env. */
export const envFileShown = (): string => envFile().replace(homedir(), "~");

let cache: { path: string; values: Map<string, string> } | undefined;
/** Keys typed in the editor and not saved yet, so Test can use them (never in process.env). */
const pending = new Map<string, string>();

function parse(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(m[1]!, value);
  }
  return values;
}

function fileValues(): Map<string, string> {
  const path = envFile();
  if (cache?.path !== path) cache = { path, values: existsSync(path) ? parse(readFileSync(path, "utf8")) : new Map() };
  return cache.values;
}

/** The key in a variable: the environment wins over the file, as with any .env. */
export function secret(name: string): string | undefined {
  return pending.get(name) || process.env[name] || fileValues().get(name) || undefined;
}

/** Runs `fn` as if the key were saved (the editor's Test with a key just typed). */
export async function withSecret<T>(name: string | undefined, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!name || !value) return fn();
  pending.set(name, value);
  try {
    return await fn();
  } finally {
    pending.delete(name);
  }
}

/** Where a key comes from, for the screens (never the key itself). */
export function secretSource(name: string): "environment" | "file" | undefined {
  if (pending.get(name) || process.env[name]) return "environment";
  return fileValues().get(name) ? "file" : undefined;
}

/** "••••1234": enough to tell two keys apart. */
export const masked = (value: string): string => `••••${value.slice(-4)}`;

/** Adds or replaces a key in the file, which only its owner can read. */
export function saveSecret(name: string, value: string): void {
  const path = envFile();
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const line = `${name}=${value}`;
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (at >= 0 && at < lines.length) lines[at] = line;
  else lines.push(line);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  cache = undefined;
}

/** A warning when other users of the machine can read the keys. */
export function envFileWarning(): string | undefined {
  const path = envFile();
  if (!existsSync(path)) return;
  if (statSync(path).mode & 0o077) return `${path.replace(homedir(), "~")} can be read by other users: chmod 600 it`;
}
