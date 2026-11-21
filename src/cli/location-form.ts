import { basename } from "node:path";
import { CLI_PRESETS, masked, secret, type Config, type LocationConfig, type MachineProvider } from "../core/index.ts";
import { value, type Form, type FormField } from "./form.ts";

/**
 * The editor's forms: a location (this machine, another machine, an API) and a machine's provider (a server or a
 * CLI). Editing keeps what the form does not show (timeouts, extra body fields, a CLI's arguments).
 */
export const LOCATION_KINDS = [
  { value: "this", label: "This machine" },
  { value: "machine", label: "Another machine" },
  { value: "google", label: "Google API (Vertex AI)" },
  { value: "anthropic", label: "Anthropic API" },
  { value: "api", label: "OpenAI-compatible API" },
] as const;
type LocationKind = (typeof LOCATION_KINDS)[number]["value"];

export const PROVIDER_KINDS = [
  { value: "server", label: "Server (Ollama, llama.cpp, LM Studio, vLLM)" },
  { value: "cli", label: "CLI (claude, agy, opencode, kimi or any other)" },
] as const;
type ProviderKind = (typeof PROVIDER_KINDS)[number]["value"];

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

export interface Draft<T> {
  /** The name before editing; undefined for a new one. */
  original?: string;
  existing?: T;
  form: Form;
}

const text = (key: string, label: string, v: Record<string, string>, placeholder?: string, hint?: string, more: Partial<FormField> = {}): FormField =>
  ({ type: "text", key, label, value: v[key] ?? "", placeholder, hint, ...more }) as FormField;

/** The variable a location's key goes in: the usual one for the API, or NAME_API_KEY. */
export function keyEnv(kind: string, name: string, existing?: string): string {
  if (existing) return existing;
  if (kind === "google") return "GOOGLE_API_KEY";
  if (kind === "anthropic") return "ANTHROPIC_API_KEY";
  return `${(name || "api").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function keyField(kind: string, name: string, existingEnv: string | undefined, typed: string): FormField {
  const env = keyEnv(kind, name, existingEnv);
  const saved = secret(env);
  const placeholder = saved ? `${masked(saved)} · type to replace` : kind === "google" ? "empty: gcloud's login" : "paste the key";
  return text("key", "Key", { key: typed }, placeholder, `kept in ~/.kli/.env as ${env}, never in the config`, { secret: true });
}

export function locationFields(kind: LocationKind, v: Record<string, string>, existingEnv?: string): FormField[] {
  const head: FormField[] = [
    text("name", "Name", v, "a short name, e.g. gpu-box"),
    { type: "choice", key: "kind", label: "Kind", value: kind, options: LOCATION_KINDS.map((k) => ({ ...k })) },
  ];
  const model = text("model", "Model", v, "Enter lists what it offers", "used when you name only the location", { list: true });
  switch (kind) {
    case "this":
      return head;
    case "machine":
      return [
        ...head,
        text("host", "Address", v, "192.168.10.230 or a name on the network"),
        text("ssh", "SSH", v, "user@host, or an alias of ~/.ssh/config", "runs its CLIs and reaches servers that only listen on localhost"),
        text("jump", "Through", v, "a machine to go through (ssh -J), if any"),
      ];
    case "google":
      return [...head, text("project", "Project", v, "the GCP project"), text("region", "Region", v, "global", "global, or a region such as us-central1"), keyField(kind, v.name ?? "", existingEnv, v.key ?? ""), model];
    case "anthropic":
      return [...head, keyField(kind, v.name ?? "", existingEnv, v.key ?? ""), model];
    case "api":
      return [...head, text("url", "URL", v, "https://openrouter.ai/api/v1", "base URL with /v1"), keyField(kind, v.name ?? "", existingEnv, v.key ?? ""), model];
  }
}

function locationValues(name: string, l: LocationConfig): Record<string, string> {
  const v: Record<string, string> = { name, kind: l.type === "machine" ? (l.host || l.ssh ? "machine" : "this") : l.type };
  if (l.type === "machine") Object.assign(v, { host: l.host ?? "", ssh: l.ssh ?? "", jump: l.jump ?? "" });
  if (l.type === "google") Object.assign(v, { project: l.project, region: l.region ?? "", model: l.model ?? "" });
  if (l.type === "anthropic") v.model = l.model ?? "";
  if (l.type === "api") Object.assign(v, { url: l.url, model: l.model ?? "" });
  return v;
}

const currentValues = (form: Form): Record<string, string> =>
  Object.fromEntries(form.fields.filter((f) => f.type !== "checks").map((f) => [f.key, (f as { value: string }).value]));

const existingEnv = (l?: LocationConfig) => (l && "apiKeyEnv" in l ? l.apiKeyEnv : undefined);

export function locationForm(config: Config, name?: string, focusKey = false): Draft<LocationConfig> {
  const existing = name ? config.locations[name] : undefined;
  const v = existing && name ? locationValues(name, existing) : { kind: "machine" };
  const fields = locationFields(v.kind as LocationKind, v, existingEnv(existing));
  const form: Form = {
    title: name ? `Edit location · ${name}` : "New location",
    subtitle: "Where inference runs: this machine, another one, or an API.",
    fields,
    buttons: ["Save", "Test", "Cancel"],
    index: focusKey ? Math.max(0, fields.findIndex((f) => f.key === "key")) : 0,
    cursor: focusKey ? 0 : Array.from(v.name ?? "").length,
  };
  return { original: name, existing, form };
}

/** Rebuilds the fields after the kind changed, keeping what was typed. */
export function changeLocationKind(draft: Draft<LocationConfig>): void {
  const { form } = draft;
  form.fields = locationFields(value(form, "kind") as LocationKind, currentValues(form), existingEnv(draft.existing));
  form.index = 1;
}

/**
 * The location the form describes, and the key typed (to save in ~/.kli/.env). With `strict` false (Test before
 * naming it), a missing name is allowed. Throws an Error naming the first missing field.
 */
export function readLocation(draft: Draft<LocationConfig>, strict = true): { name: string; location: LocationConfig; key?: { env: string; value: string } } {
  const { form, existing } = draft;
  const v = (key: string) => value(form, key).trim();
  const need = (key: string, label: string) => {
    if (!v(key)) throw new Error(`${label} is missing`);
    return v(key);
  };
  const name = strict ? need("name", "Name") : v("name") || "draft";
  if (strict && !NAME.test(name)) throw new Error("Name: letters, digits, dot, dash or underscore");
  const kind = v("kind") as LocationKind;
  const type = kind === "this" ? "machine" : kind;
  const same = existing?.type === type ? (structuredClone(existing) as unknown as Record<string, unknown>) : undefined;
  const set = (target: Record<string, unknown>, key: string, text: string) => {
    if (text) target[key] = text;
    else delete target[key];
  };
  let location: LocationConfig;
  let key: { env: string; value: string } | undefined;
  if (type === "machine") {
    const l = (same ?? { type: "machine", providers: {} }) as Record<string, unknown>;
    if (kind === "machine") {
      if (!v("host") && !v("ssh")) throw new Error("Address or SSH is missing");
      set(l, "host", v("host"));
      set(l, "ssh", v("ssh"));
      set(l, "jump", v("jump"));
    } else for (const k of ["host", "ssh", "jump", "sshOptions"]) delete l[k];
    location = l as unknown as LocationConfig;
  } else {
    const l = (same ?? { type }) as Record<string, unknown>;
    if (type === "google") {
      l.project = need("project", "Project");
      set(l, "region", v("region"));
    }
    if (type === "api") l.url = need("url", "URL");
    set(l, "model", v("model"));
    const env = keyEnv(type, name, existingEnv(existing));
    if (v("key")) {
      key = { env, value: v("key") };
      l.apiKeyEnv = env;
    } else if (type !== "google" || existingEnv(existing)) l.apiKeyEnv = env;
    if (type === "anthropic" && l.apiKeyEnv === "ANTHROPIC_API_KEY") delete l.apiKeyEnv; // the default
    location = l as unknown as LocationConfig;
  }
  return { name, location, key };
}

/** The fields of a machine's provider. */
export function providerFields(kind: ProviderKind, v: Record<string, string>, remote: boolean): FormField[] {
  const head: FormField[] = [
    text("name", "Name", v, "e.g. ollama, claude"),
    { type: "choice", key: "kind", label: "Kind", value: kind, options: PROVIDER_KINDS.map((k) => ({ ...k })) },
  ];
  const known = Object.keys(CLI_PRESETS).join(", ");
  if (kind === "server")
    return [
      ...head,
      text("port", "Port", v, "11434", "Ollama 11434 · llama.cpp 8080 · LM Studio 1234 · vLLM 8000"),
      ...(remote
        ? [{ type: "choice", key: "tunnel", label: "Reach", value: v.tunnel || "no", options: [{ value: "no", label: "over the network" }, { value: "yes", label: "through an ssh tunnel (it listens only on localhost)" }] } as FormField]
        : []),
      text("model", "Model", v, "Enter lists what it offers", undefined, { list: true }),
    ];
  return [
    ...head,
    text("command", "Command", v, "claude", `${known}, or any command`),
    text("args", "Arguments", v, "empty: how Kli runs it", "{prompt} and {model} are replaced; empty for the CLIs Kli knows"),
    text("model", "Model", v, "empty: the CLI's own default", undefined, { list: true }),
  ];
}

function providerValues(name: string, p: MachineProvider): Record<string, string> {
  const v: Record<string, string> = { name, kind: p.type, model: p.model ?? "" };
  if (p.type === "server") Object.assign(v, { port: String(p.port), tunnel: p.tunnel ? "yes" : "no" });
  else Object.assign(v, { command: p.command, args: p.args ? p.args.map((a) => (a === "" || /\s/.test(a) ? `'${a}'` : a)).join(" ") : "" });
  return v;
}

export function providerForm(config: Config, location: string, name?: string): Draft<MachineProvider> {
  const l = config.locations[location];
  const remote = l?.type === "machine" && !!(l.host || l.ssh);
  const existing = name && l?.type === "machine" ? l.providers[name] : undefined;
  const v = existing && name ? providerValues(name, existing) : { kind: "server", port: "11434", name: "ollama" };
  return {
    original: name,
    existing,
    form: {
      title: name ? `Edit provider · ${location}/${name}` : `New provider · ${location}`,
      subtitle: "A server that answers over HTTP, or a CLI that Kli runs without interaction.",
      fields: providerFields(v.kind as ProviderKind, v, remote),
      buttons: ["Save", "Test", "Cancel"],
      index: 0,
      cursor: Array.from(v.name ?? "").length,
    },
  };
}

export function changeProviderKind(draft: Draft<MachineProvider>, remote: boolean): void {
  const { form } = draft;
  const v = currentValues(form);
  if (value(form, "kind") === "cli" && (!v.name || v.name === "ollama")) v.name = "";
  form.fields = providerFields(value(form, "kind") as ProviderKind, v, remote);
  form.index = 1;
}

/** Splits "a 'b c' d" into words. */
const words = (s: string) => (s.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));

/** The provider the form describes. Throws an Error naming the first missing field. */
export function readMachineProvider(draft: Draft<MachineProvider>, strict = true): { name: string; provider: MachineProvider } {
  const { form, existing } = draft;
  const v = (key: string) => value(form, key).trim();
  const name = v("name") || (strict ? "" : "draft");
  if (!name) throw new Error("Name is missing");
  if (strict && !NAME.test(name)) throw new Error("Name: letters, digits, dot, dash or underscore");
  const set = (target: Record<string, unknown>, key: string, text: string) => {
    if (text) target[key] = text;
    else delete target[key];
  };
  if (v("kind") === "server") {
    const port = Number(v("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port: a number from 1 to 65535");
    const p = (existing?.type === "server" ? structuredClone(existing) : { type: "server", port }) as Record<string, unknown>;
    p.port = port;
    if (v("tunnel") === "yes") p.tunnel = true;
    else delete p.tunnel;
    set(p, "model", v("model"));
    return { name, provider: p as unknown as MachineProvider };
  }
  const command = v("command");
  if (!command) throw new Error("Command is missing");
  const keep = existing?.type === "cli" && existing.command === command;
  const p = (keep ? structuredClone(existing) : { type: "cli", command }) as Record<string, unknown>;
  // empty: the arguments Kli knows for this CLI (or the prompt alone, for one it does not know)
  if (v("args")) p.args = words(v("args"));
  else delete p.args;
  set(p, "model", v("model"));
  return { name, provider: p as unknown as MachineProvider };
}
