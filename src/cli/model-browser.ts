import { basename } from "node:path";
import { homedir } from "node:os";
import {
  CLI_PRESETS,
  describeLocation,
  discover,
  isMachine,
  putLocation,
  putProvider,
  removeLocation,
  removeProvider,
  saveSecret,
  withSecret,
  type Config,
  type Core,
  type LocationConfig,
  type MachineProvider,
  type ModelInfo,
} from "../core/index.ts";
import { value, type Form } from "./form.ts";
import { changeLocationKind, changeProviderKind, locationForm, providerForm, readLocation, readMachineProvider, type Draft } from "./location-form.ts";
import { formOverlay, pickerOverlay, type Overlay } from "./overlay.ts";
import { chosen, type Picker } from "./picker.ts";

/**
 * `/model`: location → provider → model. Enter goes one level down and, on a model, uses it; a, e and d add, edit
 * and delete locations and providers; on a machine, f finds what it has. Saving writes the config file and the
 * session goes on with it.
 */
export interface BrowserHost {
  core: Core;
  /** The model the session is on. */
  current(): string | undefined;
  choose(ref: string): void;
  /** A location or provider was renamed (to) or deleted (no `to`): the session follows it. */
  moved(from: string, to?: string): void;
  push(overlay: Overlay): void;
  pop(): void;
  /** Closes every overlay (a model was chosen). */
  close(): void;
  /** Something changed while waiting (a listing, a test): draw again. */
  update(): void;
}

/** Ollama answers to "lfm3" and lists it as "lfm3:latest". */
export const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;

/** The model lists, asked once per config (an edit asks again). */
const lists = new WeakMap<Config, Map<string, Promise<ModelInfo[]>>>();
function modelsOf(core: Core, ref: string): Promise<ModelInfo[]> {
  let byRef = lists.get(core.config);
  if (!byRef) lists.set(core.config, (byRef = new Map()));
  let list = byRef.get(ref);
  if (!list) {
    list = core.models(ref);
    byRef.set(ref, list);
    list.catch(() => byRef!.delete(ref));
  }
  return list;
}

const file = (core: Core) => (core.configPath ?? "").replace(homedir(), "~");
const under = (ref: string | undefined, prefix: string) => !!ref && (ref === prefix || ref.startsWith(`${prefix}/`));

/** A location in a few words, for the list (the whole description goes on its own screen). */
function shortPlace(l: LocationConfig): string {
  if (l.type === "machine") return l.ssh ? `ssh ${l.ssh}` : (l.host ?? "this machine");
  if (l.type === "google") return `Google API · ${l.region ?? "global"}`;
  if (l.type === "anthropic") return "Anthropic API";
  return describeLocation(l);
}

function providerDetail(p: MachineProvider): string {
  if (p.type === "server") return `server :${p.port}${p.tunnel ? " · ssh tunnel" : ""}`;
  const known = CLI_PRESETS[basename(p.command)];
  return `cli ${p.command}${known ? ` · ${known.label}` : ""}`;
}

/** Level 1: the locations. */
export function openBrowser(host: BrowserHost, focus?: string, message?: Picker["message"]): void {
  const { core } = host;
  const names = Object.keys(core.config.locations);
  const current = host.current();
  const picker: Picker = {
    title: "Model › where",
    subtitle: current ? `Using ${current}. Enter opens a location: its providers, then their models.` : "Enter opens a location: its providers, then their models.",
    options: names.map((name) => {
      const l = core.config.locations[name]!;
      const status = core.status(name);
      return {
        label: name,
        detail: shortPlace(l),
        note: isMachine(l) ? [l.jump ? `via ${l.jump}` : "", Object.keys(l.providers).join(" · ") || "no providers yet"].filter(Boolean).join(" · ") : l.model ? `default ${l.model}` : "",
        problem: status.ready ? undefined : `${status.auth.replace(/^needs /, "locked: needs ")} · Enter adds it`,
        current: under(current, name),
      };
    }),
    index: Math.max(0, names.indexOf(focus ?? current?.split("/")[0] ?? "")),
    actions: [
      { key: "a", label: "add" },
      { key: "e", label: "edit" },
      { key: "d", label: "delete" },
    ],
    message: message ?? (names.length ? undefined : { kind: "ok", text: "no locations yet: a adds one" }),
  };
  host.push(
    pickerOverlay(picker, (r) => {
      const name = names[picker.index];
      if (r === "cancel") return host.pop();
      picker.message = undefined;
      if (r === "choose") {
        if (!name) return;
        // a locked API opens on its key
        if (!core.status(name).ready) return openLocationEditor(host, name, true);
        return openLocation(host, name);
      }
      if (r.action === "a") openLocationEditor(host);
      else if (name && r.action === "e") openLocationEditor(host, name);
      else if (name && r.action === "d") confirmDelete(host, name);
    }),
  );
}

/** Level 2: a machine's providers, or the makers whose models an API offers. */
function openLocation(host: BrowserHost, name: string, message?: Picker["message"]): void {
  const { core } = host;
  const l = core.config.locations[name]!;
  if (!isMachine(l)) return openMakers(host, name);
  const names = Object.keys(l.providers);
  const current = host.current();
  const remote = !!(l.host || l.ssh);
  const picker: Picker = {
    title: `Model › ${name}`,
    subtitle: `${describeLocation(l)}. Enter lists a provider's models.`,
    options: names.map((p) => {
      const prov = l.providers[p]!;
      const missing = !remote && prov.type === "cli" && !Bun.which(prov.command);
      return {
        label: p,
        detail: providerDetail(prov),
        note: prov.model ? `default ${prov.model}` : prov.type === "cli" ? "its own default model" : "",
        problem: missing ? "not installed" : undefined,
        current: under(current, `${name}/${p}`),
      };
    }),
    index: Math.max(0, names.findIndex((p) => under(current, `${name}/${p}`))),
    actions: [
      { key: "a", label: "add" },
      { key: "e", label: "edit" },
      { key: "d", label: "delete" },
      { key: "f", label: "find" },
    ],
    message: message ?? (names.length ? undefined : { kind: "ok", text: `no providers yet: f finds what ${name} has, a adds one` }),
  };
  host.push(
    pickerOverlay(picker, (r) => {
      const p = names[picker.index];
      if (r === "cancel") return host.pop();
      picker.message = undefined;
      if (r === "choose") return p ? openModels(host, `${name}/${p}`) : undefined;
      if (r.action === "a") openProviderEditor(host, name);
      else if (p && r.action === "e") openProviderEditor(host, name, p);
      else if (p && r.action === "d") confirmDelete(host, name, p);
      else if (r.action === "f") void find(host, name, picker);
    }),
  );
}

/** f: adds what the machine has and the config does not. */
async function find(host: BrowserHost, name: string, picker: Picker): Promise<void> {
  const { core } = host;
  const l = core.config.locations[name]!;
  if (!isMachine(l)) return;
  picker.message = { kind: "busy", text: `looking at ${name}…` };
  host.update();
  try {
    const found = await discover(l);
    const have = Object.values(l.providers);
    const fresh = Object.entries(found).filter(
      ([key, p]) => !l.providers[key] && !have.some((h) => (p.type === "server" ? h.type === "server" && h.port === p.port : h.type === "cli" && h.command === p.command)),
    );
    if (!fresh.length) {
      picker.message = { kind: "ok", text: `nothing new on ${name}` };
      return host.update();
    }
    let next = core.config;
    for (const [key, p] of fresh) next = putProvider(next, name, key, p);
    core.apply(next);
    host.pop();
    openLocation(host, name, { kind: "ok", text: `found ${fresh.map(([key, p]) => (p.type === "server" ? `${key} :${p.port}` : key)).join(", ")}` });
  } catch (e) {
    picker.message = { kind: "error", text: (e as Error).message };
  }
  host.update();
}

/** Level 2 on an API: the makers (DeepSeek, Google...), or straight to the models when there is only one. */
function openMakers(host: BrowserHost, name: string): void {
  const picker: Picker = { title: `Model › ${name}`, options: [], index: 0, message: { kind: "busy", text: `asking ${name} for its models…` } };
  let makers: string[] = [];
  host.push(
    pickerOverlay(picker, (r) => {
      if (r === "cancel") return host.pop();
      if (r === "choose" && makers[picker.index]) openModels(host, name, makers[picker.index]);
    }),
  );
  modelsOf(host.core, name).then(
    (models) => {
      const groups = new Map<string, number>();
      for (const m of models) {
        const maker = m.id.includes("/") ? m.id.split("/", 1)[0]! : "";
        groups.set(maker, (groups.get(maker) ?? 0) + 1);
      }
      if (groups.size <= 1) {
        host.pop();
        return openModels(host, name, [...groups.keys()][0] || undefined);
      }
      makers = [...groups.keys()];
      const current = host.current();
      picker.options = makers.map((m) => ({ label: m, detail: `${groups.get(m)} model${groups.get(m) === 1 ? "" : "s"}`, current: under(current, `${name}/${m}`) }));
      picker.subtitle = `${describeLocation(host.core.config.locations[name]!)}. Who made the model; Enter lists them.`;
      picker.index = Math.max(0, makers.findIndex((m) => under(current, `${name}/${m}`)));
      picker.message = undefined;
      host.update();
    },
    (e: Error) => {
      picker.message = { kind: "error", text: e.message };
      host.update();
    },
  );
}

/** Level 3: the models; typing filters, and a name the list does not have can be typed. */
function openModels(host: BrowserHost, ref: string, maker?: string): void {
  const { core } = host;
  const [name] = ref.split("/");
  const l = core.config.locations[name!]!;
  const prefix = maker ? `${ref}/${maker}` : ref;
  const cli = isMachine(l) ? l.providers[ref.split("/")[1]!] : undefined;
  const picker: Picker = {
    title: `Model › ${prefix.replaceAll("/", " › ")}`,
    options: [],
    index: 0,
    filter: "",
    typed: true,
    message: { kind: "busy", text: `asking ${ref} for its models…` },
  };
  let values: string[] = [];
  host.push(
    pickerOverlay(picker, (r) => {
      if (r === "cancel") return host.pop();
      if (r !== "choose") return;
      const c = chosen(picker);
      if (!c) return;
      host.close();
      host.choose(c.option ? c.value : `${prefix}/${c.value}`);
    }),
  );
  const current = host.current();
  const fill = (models: ModelInfo[]) => {
    const mine = models.filter((m) => !maker || m.id.startsWith(`${maker}/`));
    // a CLI can run on its own default model
    const options = cli?.type === "cli" ? [{ label: "default", value: ref, detail: `${cli.command}'s own default model` }] : [];
    for (const m of mine) options.push({ label: maker ? m.id.slice(maker.length + 1) : m.id, value: `${name}/${isMachine(l) ? `${ref.split("/")[1]}/` : ""}${m.id}`, detail: m.detail ?? "" });
    values = options.map((o) => o.value);
    picker.options = options.map((o) => ({ ...o, current: !!current && sameModel(o.value, current) }));
    picker.subtitle = `${mine.length} offered. Enter uses one in this session; type to filter or to name another.`;
    picker.index = Math.max(0, values.findIndex((v) => !!current && sameModel(v, current)));
    picker.message = undefined;
    host.update();
  };
  modelsOf(core, ref).then(fill, (e: Error) => {
    if (cli?.type === "cli") fill([]);
    picker.message = { kind: "error", text: `${e.message} · type a model name` };
    host.update();
  });
}

function openLocationEditor(host: BrowserHost, name?: string, focusKey = false): void {
  const { core } = host;
  const draft = locationForm(core.config, name, focusKey);
  if (focusKey) draft.form.message = { kind: "info", text: "this API needs its key to list and answer" };
  let open = true;
  host.push(
    formOverlay(draft.form, (a) => {
      if (a.kind === "cancel" || (a.kind === "button" && a.button === "Cancel")) {
        open = false;
        return host.pop();
      }
      if (a.kind === "change") {
        if (a.key === "kind") changeLocationKind(draft);
        draft.form.message = undefined;
        return;
      }
      if (a.kind === "list") return void listInto(host, draft.form, () => draftLocation(host, draft), () => open);
      if (a.button === "Test") return void testLocation(host, draft);
      if (a.button === "Save") return void saveLocation(host, draft, () => (open = false));
    }),
  );
}

/** The config with the location in the form, for listing and testing before saving. */
function draftLocation(host: BrowserHost, draft: Draft<LocationConfig>): { config: Config; name: string; key?: { env: string; value: string } } {
  const { name, location, key } = readLocation(draft, false);
  return { config: putLocation(host.core.config, name, location, draft.original), name, key };
}

/** Enter on a Model field: what the location or provider offers, in a picker that fills the field. */
async function listInto(host: BrowserHost, form: Form, read: () => { config: Config; name: string; key?: { env: string; value: string } }, isOpen: () => boolean): Promise<void> {
  let draft: ReturnType<typeof read>;
  try {
    draft = read();
  } catch (e) {
    form.message = { kind: "error", text: `${(e as Error).message}: it is needed to list the models` };
    return host.update();
  }
  form.message = { kind: "busy", text: `asking ${draft.name} for its models…` };
  host.update();
  try {
    const models = await withSecret(draft.key?.env, draft.key?.value, () => host.core.models(draft.name, draft.config));
    if (!isOpen()) return;
    form.message = models.length ? undefined : { kind: "error", text: "it lists no models: type one" };
    if (!models.length) return host.update();
    const current = value(form, "model");
    const picker: Picker = {
      title: `Models · ${draft.name}`,
      subtitle: `${models.length} offered. Enter puts one in the Model field.`,
      options: models.map((m) => ({ label: m.id, detail: m.detail, current: sameModel(m.id, current) })),
      index: Math.max(0, models.findIndex((m) => sameModel(m.id, current))),
      filter: "",
      typed: true,
    };
    host.push(
      pickerOverlay(picker, (r) => {
        if (r === "cancel") return host.pop();
        if (r !== "choose") return;
        const c = chosen(picker);
        const field = form.fields.find((f) => f.key === "model");
        if (c && field?.type === "text") {
          field.value = c.value;
          form.cursor = Array.from(field.value).length;
        }
        host.pop();
      }),
    );
  } catch (e) {
    if (isOpen()) form.message = { kind: "error", text: (e as Error).message };
  }
  host.update();
}

async function testLocation(host: BrowserHost, draft: Draft<LocationConfig>): Promise<void> {
  const { form } = draft;
  const say = (kind: NonNullable<Form["message"]>["kind"], text: string) => {
    form.message = { kind, text };
    host.update();
  };
  let d: ReturnType<typeof draftLocation>;
  try {
    d = draftLocation(host, draft);
  } catch (e) {
    return say("error", (e as Error).message);
  }
  const l = d.config.locations[d.name]!;
  if (isMachine(l)) {
    say("busy", `looking at ${d.name}…`);
    try {
      const found = await discover(l);
      const list = Object.entries(found).map(([k, p]) => (p.type === "server" ? `${k} :${p.port}${p.tunnel ? " (tunnel)" : ""}` : k));
      return say("ok", list.length ? `found ${list.join(", ")}` : "reachable, but no server or CLI that Kli knows");
    } catch (e) {
      return say("error", (e as Error).message);
    }
  }
  say("busy", `asking ${d.name} for its models…`);
  await withSecret(d.key?.env, d.key?.value, async () => {
    try {
      const models = await host.core.models(d.name, d.config);
      const model = value(form, "model").trim();
      if (!model) return say("ok", `${models.length} models offered · name one to test it`);
      say("busy", `${models.length} models · asking ${model} to reply "ok"…`);
      const r = await host.core.check(`${d.name}/${model}`, d.config);
      say(r.ok ? "ok" : "error", r.ok ? `${models.length} models · ${model} answered in ${((r.ms ?? 0) / 1000).toFixed(1)}s: ${JSON.stringify(r.reply)}` : (r.error ?? "failed"));
    } catch (e) {
      say("error", (e as Error).message);
    }
  });
}

async function saveLocation(host: BrowserHost, draft: Draft<LocationConfig>, closed: () => void): Promise<void> {
  const { core } = host;
  const { form } = draft;
  try {
    const { name, location, key } = readLocation(draft);
    let next = putLocation(core.config, name, location, draft.original);
    let found = "";
    // a new machine starts with what it has
    if (!draft.original && isMachine(location)) {
      form.message = { kind: "busy", text: `looking at ${name}…` };
      host.update();
      try {
        const providers = await discover(location);
        for (const [k, p] of Object.entries(providers)) next = putProvider(next, name, k, p);
        found = Object.keys(providers).length ? `found ${Object.keys(providers).join(", ")}` : "found nothing it knows: a adds a provider";
      } catch (e) {
        found = `saved, but ${(e as Error).message}`;
      }
    }
    if (key) saveSecret(key.env, key.value);
    core.apply(next);
    closed();
    if (draft.original && draft.original !== name) host.moved(draft.original, name);
    host.pop(); // the form
    host.pop(); // the list, now out of date
    const saved = { kind: "ok" as const, text: `saved ${name} → ${file(core)}${key ? ` · key in ~/.kli/.env` : ""}` };
    openBrowser(host, name, isMachine(location) ? undefined : saved);
    if (isMachine(location)) openLocation(host, name, found ? { kind: found.startsWith("saved, but") ? "error" : "ok", text: found } : saved);
  } catch (e) {
    form.message = { kind: "error", text: (e as Error).message.replace(/\s*\n\s*-?\s*/g, " ") };
    host.update();
  }
}

function openProviderEditor(host: BrowserHost, location: string, name?: string): void {
  const { core } = host;
  const l = core.config.locations[location]!;
  const remote = isMachine(l) && !!(l.host || l.ssh);
  const draft = providerForm(core.config, location, name);
  let open = true;
  const read = () => {
    const { name: n, provider } = readMachineProvider(draft, false);
    return { config: putProvider(core.config, location, n, provider, draft.original), name: `${location}/${n}` };
  };
  host.push(
    formOverlay(draft.form, (a) => {
      if (a.kind === "cancel" || (a.kind === "button" && a.button === "Cancel")) {
        open = false;
        return host.pop();
      }
      if (a.kind === "change") {
        if (a.key === "kind") changeProviderKind(draft, remote);
        draft.form.message = undefined;
        return;
      }
      if (a.kind === "list") return void listInto(host, draft.form, read, () => open);
      if (a.button === "Test") return void testProvider(host, draft.form, read);
      if (a.button === "Save") {
        try {
          const { name: n, provider } = readMachineProvider(draft);
          core.apply(putProvider(core.config, location, n, provider, draft.original));
          open = false;
          if (draft.original && draft.original !== n) host.moved(`${location}/${draft.original}`, `${location}/${n}`);
          host.pop();
          host.pop();
          openLocation(host, location, { kind: "ok", text: `saved ${location}/${n}${provider.model ? ` · ${provider.model}` : ""} → ${file(core)}` });
        } catch (e) {
          draft.form.message = { kind: "error", text: (e as Error).message.replace(/\s*\n\s*-?\s*/g, " ") };
        }
      }
    }),
  );
}

async function testProvider(host: BrowserHost, form: Form, read: () => { config: Config; name: string }): Promise<void> {
  let d: { config: Config; name: string };
  try {
    d = read();
  } catch (e) {
    form.message = { kind: "error", text: (e as Error).message };
    return host.update();
  }
  const model = value(form, "model").trim();
  const ref = model ? `${d.name}/${model}` : d.name;
  form.message = { kind: "busy", text: `asking ${ref} to reply "ok"…` };
  host.update();
  const r = await host.core.check(ref, d.config);
  form.message = r.ok
    ? { kind: "ok", text: `${r.target?.ref ?? ref} answered in ${((r.ms ?? 0) / 1000).toFixed(1)}s: ${JSON.stringify(r.reply)}` }
    : { kind: "error", text: r.skipped ? `not tested: ${r.error}` : (r.error ?? "failed") };
  host.update();
}

function confirmDelete(host: BrowserHost, location: string, provider?: string): void {
  const { core } = host;
  const what = provider ? `${location}/${provider}` : location;
  const l = core.config.locations[location]!;
  const subtitle = provider ? "The model and the fallback stop pointing at it." : isMachine(l) && Object.keys(l.providers).length ? `With its providers: ${Object.keys(l.providers).join(", ")}.` : "The model and the fallback stop pointing at it.";
  const picker: Picker = { title: `Delete ${what}?`, subtitle, options: [{ label: "No, keep it" }, { label: `Yes, delete ${what}` }], index: 0 };
  host.push(
    pickerOverlay(picker, (r) => {
      if (r === "cancel" || (r === "choose" && picker.index === 0)) return host.pop();
      if (r !== "choose") return;
      try {
        const { config, changed } = provider ? removeProvider(core.config, location, provider) : removeLocation(core.config, location);
        core.apply(config);
        host.moved(what);
        host.pop(); // the question
        host.pop(); // the list
        const message = { kind: "ok" as const, text: `deleted ${what}${changed.length ? ` · ${changed.join(" · ")}` : ""}` };
        if (provider) openLocation(host, location, message);
        else openBrowser(host, undefined, message);
      } catch (e) {
        picker.message = { kind: "error", text: (e as Error).message };
      }
    }),
  );
}
