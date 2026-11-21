import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMachine, resolveRef } from "./locations.ts";
import { sourceProblems } from "./sources/index.ts";
import { stackProblems } from "./stack.ts";
import { ConfigError, LOCATION_TYPES, type Config, type LocationConfig, type MachineProvider, type SourceConfig, type StackConfig } from "./types.ts";

export const KLI_DIR = join(homedir(), ".kli");

/** Where to look for the config, in order: $KLI_CONFIG, ./kli.json, ~/.kli/config.json. */
export function findConfig(): string | undefined {
  const candidates = [process.env.KLI_CONFIG, join(process.cwd(), "kli.json"), join(KLI_DIR, "config.json")];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }
  return validateConfig(raw, path);
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** Rejects the whole config if a location or provider is incomplete, or the model or the fallback name nothing. */
export function validateConfig(raw: unknown, source = "config"): Config {
  const c = raw as Config & { profiles?: unknown };
  if (!c || typeof c !== "object") throw new ConfigError(`${source}: expected a JSON object`);
  if (c.profiles || (!c.locations && (c as { providers?: unknown }).providers))
    throw new ConfigError(`${source}: this config is from before locations (profiles and providers); see kli.example.json`);
  const problems: string[] = [];
  if (!c.locations || typeof c.locations !== "object") problems.push('missing "locations"');

  for (const [name, l] of Object.entries(c.locations ?? {})) {
    if (!NAME.test(name)) problems.push(`location "${name}": use letters, digits, dot, dash or underscore`);
    if (!LOCATION_TYPES.includes(l.type)) {
      problems.push(`location "${name}": type "${(l as { type?: string }).type}" is not supported (${LOCATION_TYPES.join(", ")})`);
      continue;
    }
    if (l.type === "google" && !l.project) problems.push(`location "${name}": missing "project" (the GCP project)`);
    if (l.type === "api" && !l.url) problems.push(`location "${name}": missing "url"`);
    if (!isMachine(l)) continue;
    if (!l.providers || typeof l.providers !== "object") {
      problems.push(`location "${name}": missing "providers"`);
      continue;
    }
    for (const [key, p] of Object.entries(l.providers)) {
      const where = `${name}/${key}`;
      if (!NAME.test(key)) problems.push(`provider "${where}": use letters, digits, dot, dash or underscore`);
      if (p.type === "server") {
        if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) problems.push(`provider "${where}": missing "port"`);
        if (p.tunnel && !l.host && !l.ssh) problems.push(`provider "${where}": a tunnel needs the location's "ssh"`);
      } else if (p.type === "cli") {
        if (!p.command) problems.push(`provider "${where}": missing "command"`);
      } else problems.push(`provider "${where}": type "${(p as { type?: string }).type}" is not supported (server, cli)`);
    }
  }
  if (!problems.length)
    for (const [role, ref] of [["model", c.model], ...(c.fallback ?? []).map((f) => ["fallback", f])] as const) {
      if (!ref) continue;
      try {
        resolveRef(c, ref);
      } catch (e) {
        problems.push(`${role} "${ref}": ${(e as Error).message}`);
      }
    }
  // a node's model is checked when the stack runs: removing a location must not break the whole config
  if (c.stacks !== undefined && (typeof c.stacks !== "object" || Array.isArray(c.stacks))) problems.push('"stacks" is an object: name → { nodes }');
  else for (const [name, stack] of Object.entries(c.stacks ?? {})) problems.push(...(NAME.test(name) ? stackProblems(name, stack) : [`stack "${name}": use letters, digits, dot, dash or underscore`]));
  if (c.stack !== undefined && !c.stacks?.[c.stack]) problems.push(`stack "${c.stack}" is not one of the stacks`);
  if (c.triage !== undefined && (typeof c.triage !== "object" || typeof c.triage.model !== "string" || !c.triage.model)) problems.push('"triage" is { "model": "location/provider/model" }');
  else if (c.triage && !problems.length)
    try {
      resolveRef(c, c.triage.model);
    } catch (e) {
      problems.push(`triage model "${c.triage.model}": ${(e as Error).message}`);
    }
  problems.push(...sourceProblems(c.sources));
  if (problems.length) throw new ConfigError(`${source}:\n  - ${problems.join("\n  - ")}`);
  return c;
}

/** Points the model and the fallback at a renamed location or provider, and drops the ones that went away. */
function follow(config: Config, from: string, to?: string): string[] {
  const changed: string[] = [];
  const move = (ref: string) => (ref === from || ref.startsWith(`${from}/`) ? (to ? to + ref.slice(from.length) : undefined) : ref);
  if (config.model) {
    const next = move(config.model);
    if (next !== config.model) changed.push(next ? `model → ${next}` : `model ${config.model} removed`);
    config.model = next;
    if (!next) delete config.model;
  }
  if (config.fallback) {
    const before = config.fallback;
    config.fallback = before.map(move).filter((r): r is string => !!r);
    if (config.fallback.length < before.length) changed.push("left the fallback");
    if (!config.fallback.length) delete config.fallback;
  }
  if (config.triage) {
    const next = move(config.triage.model);
    if (next !== config.triage.model) changed.push(next ? `triage → ${next}` : `triage model ${config.triage.model} removed: the stacks take every message`);
    if (next) config.triage.model = next;
    else delete config.triage;
  }
  // a stack keeps its nodes when their model goes away (the stack says so when it runs); a rename follows
  for (const [name, stack] of Object.entries(config.stacks ?? {}))
    for (const [id, node] of Object.entries(stack.nodes)) {
      // a grounding node has no model
      if (node.model === undefined) continue;
      const next = move(node.model);
      if (next && next !== node.model) node.model = next;
      else if (!next) changed.push(`stack ${name}: node ${id} has no model now`);
      if (node.fallback) node.fallback = node.fallback.map(move).filter((r): r is string => !!r);
    }
  return changed;
}

/** Replaces `key` in a record by `name` (or adds it), keeping the order. */
function put<T>(record: Record<string, T>, name: string, value: T, previous?: string): Record<string, T> {
  const old = previous ?? name;
  const next = Object.fromEntries(Object.entries(record).map(([k, v]) => (k === old ? [name, value] : [k, v])));
  if (!(name in next)) next[name] = value;
  return next;
}

/** A copy of the config with the location added or replaced (renamed from `previous`, references included). */
export function putLocation(config: Config, name: string, location: LocationConfig, previous?: string): Config {
  if (config.locations[name] && name !== previous) throw new ConfigError(`location "${name}" already exists`);
  const next = structuredClone(config);
  next.locations = put(next.locations, name, location, previous);
  if (previous && previous !== name) follow(next, previous, name);
  return validateConfig(next);
}

/** A copy of the config without the location; the model and the fallback stop pointing at it. */
export function removeLocation(config: Config, name: string): { config: Config; changed: string[] } {
  if (!config.locations[name]) throw new ConfigError(`location "${name}" is not declared`);
  const next = structuredClone(config);
  delete next.locations[name];
  const changed = follow(next, name);
  return { config: validateConfig(next), changed };
}

/** A copy of the config with a machine's provider added or replaced (renamed from `previous`). */
export function putProvider(config: Config, location: string, name: string, provider: MachineProvider, previous?: string): Config {
  const l = config.locations[location];
  if (!l || !isMachine(l)) throw new ConfigError(`location "${location}" is not a machine`);
  if (l.providers[name] && name !== previous) throw new ConfigError(`${location} already has "${name}"`);
  const next = structuredClone(config);
  const m = next.locations[location] as typeof l;
  m.providers = put(m.providers, name, provider, previous);
  if (previous && previous !== name) follow(next, `${location}/${previous}`, `${location}/${name}`);
  return validateConfig(next);
}

/** A copy of the config without a machine's provider; the model and the fallback stop pointing at it. */
export function removeProvider(config: Config, location: string, name: string): { config: Config; changed: string[] } {
  const l = config.locations[location];
  if (!l || !isMachine(l) || !l.providers[name]) throw new ConfigError(`${location} has no provider "${name}"`);
  const next = structuredClone(config);
  delete (next.locations[location] as typeof l).providers[name];
  const changed = follow(next, `${location}/${name}`);
  return { config: validateConfig(next), changed };
}

/** A copy of the config whose triage model is `ref` (written in full); none = the stacks take every message. */
export function setTriage(config: Config, ref?: string): Config {
  const next = structuredClone(config);
  if (ref) next.triage = { ...next.triage, model: resolveRef(next, ref).ref };
  else delete next.triage;
  return validateConfig(next);
}

/** A copy of the config whose default model is `ref` (written in full: "location/provider/model"). */
export function setModel(config: Config, ref: string): Config {
  const next = structuredClone(config);
  next.model = resolveRef(next, ref).ref;
  return validateConfig(next);
}

/** A copy of the config whose stack is `name`; none = the model answers again. */
export function setStack(config: Config, name?: string): Config {
  const next = structuredClone(config);
  if (name) next.stack = name;
  else delete next.stack;
  return validateConfig(next);
}

/** A copy of the config with the stack added or replaced (renamed from `previous`: the stack that answers follows). */
export function putStack(config: Config, name: string, stack: StackConfig, previous?: string): Config {
  if (config.stacks?.[name] && name !== (previous ?? name)) throw new ConfigError(`stack "${name}" already exists`);
  const next = structuredClone(config);
  next.stacks = put(next.stacks ?? {}, name, structuredClone(stack), previous);
  if (previous && previous !== name && next.stack === previous) next.stack = name;
  return validateConfig(next);
}

/** A copy of the config without the stack; when it was the one answering, the model answers again. */
export function removeStack(config: Config, name: string): Config {
  if (!config.stacks?.[name]) throw new ConfigError(`stack "${name}" is not one of the stacks`);
  const next = structuredClone(config);
  delete next.stacks![name];
  if (!Object.keys(next.stacks!).length) delete next.stacks;
  if (next.stack === name) delete next.stack;
  return validateConfig(next);
}

/** A copy of the config with the data source added, replaced or renamed; the grounding nodes follow a rename. */
export function putSource(config: Config, name: string, source: SourceConfig, previous?: string): Config {
  if (config.sources?.[name] && name !== (previous ?? name)) throw new ConfigError(`source "${name}" already exists`);
  const next = structuredClone(config);
  next.sources = put(next.sources ?? {}, name, structuredClone(source), previous);
  if (previous && previous !== name)
    for (const stack of Object.values(next.stacks ?? {}))
      for (const node of Object.values(stack.nodes)) if (node.sources) node.sources = node.sources.map((s) => (s === previous ? name : s));
  return validateConfig(next);
}

/** A copy of the config without the data source; refused while a grounding node searches it. */
export function removeSource(config: Config, name: string): Config {
  if (!config.sources?.[name]) throw new ConfigError(`source "${name}" is not one of the sources`);
  const using = Object.entries(config.stacks ?? {}).flatMap(([s, stack]) => Object.entries(stack.nodes).filter(([, n]) => n.sources?.includes(name)).map(([id]) => `${s}/${id}`));
  if (using.length) throw new ConfigError(`source "${name}" is searched by ${using.join(", ")}: take it out of them first`);
  const next = structuredClone(config);
  delete next.sources![name];
  if (!Object.keys(next.sources!).length) delete next.sources;
  return validateConfig(next);
}

/** Writes the config back, keeping the previous version next to it (<path>.bak). */
export function saveConfig(path: string, config: Config): void {
  validateConfig(config, path);
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, path);
}
