import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  collectStats,
  ConfigError,
  Core,
  describeLocation,
  envFileWarning,
  findConfig,
  HERE,
  isMachine,
  KLI_DIR,
  listSessions,
  loadConfig,
  ProviderError,
  readTrace,
  saveConfig,
  SERVER_PORTS,
  CLI_PRESETS,
  lookAround,
  starterConfig,
  STARTER_APIS,
  stackOutputs,
  Workspace,
  type NodeResult,
  type StackResult,
  type StackRunner,
  type StoredEvent,
} from "../core/index.ts";
import { ArgsError, buildPrompt, HELP, parseArgs, type Args } from "./args.ts";
import { statsReport } from "./charts.ts";
import { gallery } from "./mascot.ts";
import { changesRows, groundRows, verdictRows } from "./stack-view.ts";
import { sameModel } from "./model-browser.ts";
import { detectTheme, TOKENS } from "./theme.ts";
import { fullscreen } from "./tui.ts";
import { openInBrowser, startBuilder } from "./stackbuilder/server.ts";
import { bold, dim, footer, green, nodeLine, red, stackFooter, useColor, visibleWidth, yellow } from "./output.ts";

export const EXIT = { ok: 0, failure: 1, usage: 2, interrupted: 130 } as const;

function openCore(): Core {
  const path = findConfig();
  if (!path) throw new ConfigError("config not found: run kli init to write one with the CLIs and local servers this machine has (or set KLI_CONFIG)");
  const warning = envFileWarning();
  if (warning) process.stderr.write(yellow(`kli: ${warning}`, useColor(process.stderr)) + "\n");
  return new Core(loadConfig(path), path);
}

async function prompt(core: Core, args: Args): Promise<number> {
  if (args.model) core.router.target(args.model); // fail early on a model the config does not have
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  if (!args.prompt && !input.trim()) {
    if (process.stdin.isTTY && !args.json && !args.print) {
      if (!process.stdout.isTTY) throw new ArgsError("an interactive session needs a terminal; use -p \"prompt\"");
      return fullscreen(core, args.model, TOKENS[await detectTheme()]);
    }
    throw new ArgsError("missing prompt");
  }

  // the stack chosen with /stack answers, unless this run names a model or another stack
  const stack = args.stack ?? (args.model ? undefined : core.config.stack);
  const text = buildPrompt(args.prompt, input);
  const err = useColor(process.stderr);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const trace = core.trace("cli");
  if (stack) {
    const runner = core.stack(stack, "cli", process.cwd(), trace);
    // a stack named with --stack takes the message; the one chosen with /stack lets its triage read it first
    const r = args.stack ? undefined : await runner.triage(text, undefined, controller.signal).catch(() => undefined);
    if (controller.signal.aborted) {
      process.stderr.write(yellow("interrupted", err) + "\n");
      return EXIT.interrupted;
    }
    if (r) process.stderr.write(dim(`triage (${r.model}, ${(r.ms / 1000).toFixed(1)}s): ${r.error ? `did not decide, so the stack runs: ${r.error}` : r.route === "one" ? "not the stack's work, the model answers alone" : "the stack's work"}`, err) + "\n");
    if (r?.route !== "one") return promptStack(args, runner, text, controller);
    await runner.close();
  }

  // no one to ask here: what needs permission is refused, unless the mode lets file edits through
  const workspace = new Workspace(process.cwd());
  workspace.mode = args.permissionMode ?? "default";
  const session = core.session("cli", workspace, trace);
  if (args.model) session.use(args.model);
  try {
    let midLine = false;
    const r = await session.send(text, {
      signal: controller.signal,
      onDelta: args.json
        ? undefined
        : (t) => {
            process.stdout.write(t);
            midLine = !t.endsWith("\n");
          },
      // the tools go to stderr, so stdout keeps only the answer
      onTool: args.json
        ? undefined
        : (e) => {
            if (e.phase !== "end") return;
            if (midLine) process.stdout.write("\n");
            midLine = false;
            const mark = e.result!.ok ? green("●", err) : red("●", err);
            process.stderr.write(`${mark} ${e.label}\n  ${dim(`⎿ ${e.result!.summary}`, err)}\n`);
          },
    });
    // what the model left running in the background stops here
    await workspace.close();
    if (args.json) {
      const { text, ...measures } = r;
      console.log(JSON.stringify({ session: session.id, ...measures, response: text }, null, 2));
    } else {
      if (!r.text.endsWith("\n")) process.stdout.write("\n");
      if (process.stderr.isTTY || r.fallback) process.stderr.write(footer(r, session.id, useColor(process.stderr)) + "\n");
    }
    return EXIT.ok;
  } catch (e) {
    if (controller.signal.aborted) {
      process.stderr.write("\n" + yellow("interrupted", useColor(process.stderr)) + "\n");
      return EXIT.interrupted;
    }
    throw e;
  }
}

/**
 * A stack answers: each node's line goes to stderr as it ends; the answers go to stdout, as they come when there is
 * one output, or one after the other, each under its node's name, when there are several to compare.
 */
async function promptStack(args: Args, runner: StackRunner, text: string, controller: AbortController): Promise<number> {
  const outputs = stackOutputs(runner.stack);
  const single = outputs.length === 1 ? outputs[0] : undefined;
  const err = useColor(process.stderr);
  const out = useColor(process.stdout);
  let streamed = false;
  let midLine = false;
  const print = (r: StackResult) => {
    if (single) {
      // streamed already, and its line ended when the node did
      const o = r.outputs[0]!;
      if (!streamed && o.text) process.stdout.write(o.text.endsWith("\n") ? o.text : o.text + "\n");
      return;
    }
    r.outputs.forEach((o, i) => {
      if (i) process.stdout.write("\n");
      process.stdout.write(bold(`── ${o.node} · ${o.answeredBy ?? o.model} ──`, out) + "\n");
      const empty = o.status === "ok" ? "(it answered with no text)" : `(${o.status}${o.error ? `: ${o.error}` : ""})`;
      process.stdout.write((o.text || dim(empty, out)) + "\n");
    });
  };
  try {
    const r = await runner.send(text, {
      signal: controller.signal,
      onEvent: args.json
        ? undefined
        : (e) => {
            // the only output streams as it comes; the other nodes report when they end
            if (e.type === "delta" && e.node === single) {
              process.stdout.write(e.text);
              streamed = true;
              midLine = !e.text.endsWith("\n");
            }
            if (e.type === "end") {
              if (midLine) process.stdout.write("\n");
              midLine = false;
              process.stderr.write(nodeLine(e.result, err) + "\n");
            }
          },
    });
    await runner.close();
    if (args.json) {
      const node = ({ text, ...m }: NodeResult) => m;
      console.log(JSON.stringify({ session: runner.id, stack: r.name, ms: r.ms, nodeMs: r.nodeMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, nodes: r.nodes.map(node), outputs: r.outputs.map((o) => ({ node: o.node, model: o.answeredBy ?? o.model, status: o.status, text: o.text })) }, null, 2));
    } else {
      print(r);
      // a verifier's verdict goes with the measurements, on stderr: stdout keeps only the answers
      for (const n of r.nodes)
        if (n.verdict) process.stderr.write("\n" + verdictRows(n.verdict, `${n.node} · ${n.answeredBy ?? n.model}`, r.outputs.map((o) => o.node), process.stderr.columns || 100, err).join("\n") + "\n");
      // who chose the answer, why, and why the ones before it in "by" did not
      for (const n of r.nodes)
        if (n.choice) {
          process.stderr.write(dim(`${n.node} chose ${n.choice.node} (${n.choice.label}), by ${n.choice.by}${n.choice.why ? `: ${n.choice.why}` : ""}`, err) + "\n");
          for (const p of n.choice.passed ?? []) process.stderr.write(dim(`  passed over ${p}`, err) + "\n");
        }
      // what the grounding nodes handed on, each excerpt where the next step read it
      const grounded = groundRows(r.nodes, process.stderr.columns || 100, err);
      if (grounded.length) process.stderr.write(grounded.join("\n") + "\n");
      // what the nodes that write changed: nothing is applied here; the diffs stay, to apply by hand
      const changes = changesRows(r.nodes, process.stderr.columns || 100, err);
      // the only node that writes changed the folder itself: there is nothing to apply
      const toApply = r.nodes.some((n) => n.changes?.files.length && !n.changes.inFolder);
      if (changes.length) process.stderr.write(changes.join("\n") + "\n" + (toApply ? dim("nothing was applied, and the copies are gone: git apply <diff>, from the top of the folder, applies one", err) + "\n" : ""));
      process.stderr.write(stackFooter(r, runner.id, err) + "\n");
    }
    return r.outputs.some((o) => o.status === "ok") ? EXIT.ok : EXIT.failure;
  } catch (e) {
    await runner.close();
    if (controller.signal.aborted) {
      process.stderr.write("\n" + yellow("interrupted", err) + "\n");
      return EXIT.interrupted;
    }
    throw e;
  }
}

function table(rows: string[][], color: boolean): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => visibleWidth(r[i]!))));
  rows.forEach((r, i) => {
    const line = r.map((c, j) => c + " ".repeat(widths[j]! - visibleWidth(c))).join("   ").trimEnd();
    console.log(i === 0 ? dim(line, color) : line);
  });
}

/** Every location → provider, with what each one uses by default and whether its credentials are there. */
function showLocations(core: Core, json: boolean): number {
  const { locations } = core.config;
  const color = useColor(process.stdout);
  if (json) {
    console.log(JSON.stringify({ model: core.config.model, fallback: core.config.fallback, locations }, null, 2));
    return EXIT.ok;
  }
  const rows: string[][] = [];
  for (const [name, l] of Object.entries(locations)) {
    const status = core.status(name);
    rows.push([name, describeLocation(l), isMachine(l) ? "" : (l.model ?? ""), status.ready ? (status.auth ? green("✓ ", color) + status.auth : "") : red("✕ ", color) + status.auth]);
    if (!isMachine(l)) continue;
    for (const [p, prov] of Object.entries(l.providers)) {
      const what = prov.type === "server" ? `server :${prov.port}${prov.tunnel ? " · ssh tunnel" : ""}` : `cli ${prov.command}`;
      let credentials = "";
      try {
        const info = core.describe(prov.model || prov.type === "cli" ? `${name}/${p}` : `${name}/${p}/x`);
        credentials = (info.ready ? green("✓ ", color) : red("✕ ", color)) + info.auth;
      } catch (e) {
        credentials = red("✕ ", color) + (e as Error).message;
      }
      rows.push([`  ${p}`, what, prov.model ?? dim(prov.type === "cli" ? "its default" : "—", color), credentials]);
    }
  }
  table([["location / provider", "where", "default model", "credentials"], ...rows], color);
  let model = "—";
  try {
    model = core.defaultModel();
  } catch {}
  console.log(dim(`model ${model}${core.config.fallback?.length ? ` · fallback ${core.config.fallback.join(" → ")}` : ""}`, color));
  return EXIT.ok;
}

/** The places `kli models` and `kli check` look at: one location or provider, or all of them. */
function places(core: Core, where?: string): string[] {
  if (where) return [where];
  return Object.entries(core.config.locations).flatMap(([name, l]) => (isMachine(l) ? Object.keys(l.providers).map((p) => `${name}/${p}`) : [name]));
}

async function showModels(core: Core, where: string | undefined, json: boolean): Promise<number> {
  const color = useColor(process.stdout);
  const all = await Promise.all(
    places(core, where).map(async (place) => {
      try {
        return { place, models: await core.models(place) };
      } catch (e) {
        return { place, error: (e as Error).message };
      }
    }),
  );
  if (json) {
    console.log(JSON.stringify(all, null, 2));
    return all.some((a) => a.error) ? EXIT.failure : EXIT.ok;
  }
  let current = "";
  try {
    current = core.defaultModel();
  } catch {}
  for (const { place, models, error } of all) {
    console.log(`${place}`);
    if (error) console.log(`  ${red(`✕ ${error}`, color)}`);
    else if (!models!.length) console.log(dim("  lists no models", color));
    else {
      const [location] = place.split("/");
      const prefix = isMachine(core.config.locations[location!]!) ? place : location;
      const rows = models!.map((m) => [sameModel(`${prefix}/${m.id}`, current) ? green("●", color) : " ", m.id, dim(m.detail ?? "", color)]);
      table([["", "model", "detail"], ...rows].map((r) => ["", ...r]), color);
    }
  }
  return all.some((a) => a.error) && where ? EXIT.failure : EXIT.ok;
}

async function showCheck(core: Core, where: string | undefined, json: boolean): Promise<number> {
  const color = useColor(process.stdout);
  // each provider's own default model (a server or an API without one is skipped)
  const refs = places(core, where).filter((place) => {
    if (where) return true;
    const [location, p] = place.split("/");
    const l = core.config.locations[location!]!;
    return isMachine(l) ? l.providers[p!]!.type === "cli" || !!l.providers[p!]!.model : !!l.model;
  });
  const results = await Promise.all(refs.map(async (ref) => ({ ref, ...(await core.check(ref)) })));
  if (json) console.log(JSON.stringify(results.map(({ target, ...r }) => ({ ...r, model: target?.ref })), null, 2));
  else
    for (const r of results) {
      const name = (r.target?.ref ?? r.ref).padEnd(36);
      if (r.ok) console.log(`${green("✓", color)} ${name} ${(r.ms! / 1000).toFixed(1)}s · ${JSON.stringify(r.reply)}`);
      else if (r.skipped) console.log(`${yellow("–", color)} ${name} skipped: ${r.error}`);
      else console.log(`${red("✕", color)} ${name} ${r.error}`);
    }
  return results.some((r) => !r.ok && !r.skipped) ? EXIT.failure : EXIT.ok;
}

function describeEvent(e: StoredEvent): string {
  // a stack's node: its name before what it did
  const time = new Date(e.ts).toTimeString().slice(0, 8) + (e.node ? `  [${e.node}]` : "");
  const short = (t?: string) => (t === undefined ? "" : JSON.stringify(t.length > 100 ? t.slice(0, 100) + "…" : t));
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  switch (e.type) {
    case "triage":
      return `${time}  triage       ${e.model} · ${secs(e.ms)} · ${e.route === "one" ? "one model answers" : "the stack runs"}${e.error ? ` (${e.error})` : ""}${e.why ? ` · ${short(e.why)}` : ""}`;
    case "stack":
      return e.phase === "start"
        ? `${time}  stack        ${e.name} · ${e.nodes?.join(", ")}`
        : `${time}  stack        ${e.name} · ${secs(e.ms ?? 0)} · ${e.ok ? "answered" : "no output answered"}`;
    case "node": {
      const tokens = e.inputTokens !== undefined ? ` · ${e.inputTokens}→${e.outputTokens} tokens` : "";
      const tools = e.tools ? ` · ${e.tools} tools${e.toolFailures ? ` (${e.toolFailures} failed${e.refused ? `, ${e.refused} refused` : ""})` : ""}` : "";
      return `${time}  node         ${e.model} · ${e.status} · ${secs(e.ms)}${tokens}${tools}${e.error ? ` · ${e.error}` : ""}`;
    }
    case "start":
      return `${time}  start        ${e.user} · ${e.surface}${e.profile ? ` · ${e.profile}` : ""}`;
    case "prompt":
      return `${time}  prompt       ${short(e.content)}`;
    case "request":
      return `${time}  request      ${e.provider} · ${e.model} · ${e.messages} messages`;
    case "response": {
      const tokens = e.inputTokens !== undefined ? ` · ${e.inputTokens}→${e.outputTokens} tokens` : "";
      return `${time}  response     ${e.provider} · ${secs(e.ms)}${tokens}  ${short(e.content)}`;
    }
    case "failure":
      return `${time}  failure      ${e.provider}${e.model ? ` · ${e.model}` : ""} · ${secs(e.ms)} · ${e.error}${e.afterText ? " (after the answer started)" : ""}`;
    case "interrupted":
      return `${time}  interrupted  ${e.provider} · ${secs(e.ms)} · by the user`;
    case "fallback":
      return `${time}  fallback     ${e.from} → ${e.to}`;
    case "tool":
      return `${time}  tool         ${e.detail} · ${secs(e.ms)} · ${e.ok ? "" : "✕ "}${e.summary}`;
    case "shell":
      return `${time}  shell        ! ${e.command} · ${secs(e.ms)} · exit ${e.code ?? "none"}`;
    case "apply":
      return `${time}  apply        ${e.files.length} file${e.files.length === 1 ? "" : "s"} +${e.added} −${e.removed} to the folder${e.patch ? ` · ${e.patch}` : ""}`;
    case "ground":
      return `${time}  ground       ${e.excerpts.length} excerpts · ${e.tokens} tokens${e.cut ? ` (${e.cut} left out)` : ""} · ${e.sources.map((x) => `${x.name} ${x.error ? `✕ ${x.error}` : `${x.kept}/${x.found}`}`).join(" · ")}`;
  }
}

function showSessions(core: Core, id: string | undefined, json: boolean): number {
  const dir = core.sessionsDir;
  const color = useColor(process.stdout);
  if (id) {
    const match = listSessions(dir, Infinity).find((s) => s === id || s.startsWith(id));
    const events = match ? readTrace(dir, match) : [];
    if (!events.length) throw new ArgsError(`session not found: "${id}"`);
    console.log(json ? JSON.stringify(events, null, 2) : events.map(describeEvent).join("\n"));
    return EXIT.ok;
  }
  const summary = listSessions(dir).map((s) => {
    const events = readTrace(dir, s);
    const prompts = events.filter((e) => e.type === "prompt");
    const last = events.findLast((e) => e.type === "response" || e.type === "failure");
    const first = prompts[0]?.type === "prompt" ? (prompts[0].content ?? "") : "";
    return { session: s, prompts: prompts.length, provider: last && "provider" in last ? last.provider : undefined, first };
  });
  if (json) console.log(JSON.stringify(summary, null, 2));
  else if (!summary.length) console.log(dim(`no sessions in ${dir}`, color));
  else
    for (const s of summary) {
      const info = dim(`${String(s.prompts).padStart(2)} prompts · ${(s.provider ?? "—").padEnd(10)}`, color);
      console.log(`${s.session}  ${info}  ${s.first.replace(/\s+/g, " ").slice(0, 60)}`);
    }
  return EXIT.ok;
}

async function showStats(core: Core, args: Args): Promise<number> {
  const days = args.days ?? 30;
  const stats = collectStats(core.sessionsDir, { days });
  if (args.json) {
    console.log(JSON.stringify({ periodDays: days, ...stats }, null, 2));
    return EXIT.ok;
  }
  const color = useColor(process.stdout);
  const tokens = TOKENS[color ? await detectTheme() : "dark"];
  const cols = Math.min(process.stdout.columns || 80, 110);
  console.log(statsReport(stats, `Kli stats · last ${days} day${days === 1 ? "" : "s"}`, cols, tokens, color).join("\n"));
  return EXIT.ok;
}

/** `kli stackbuilder`: the stack builder page, up until Ctrl+C; what is saved there goes to the config. */
async function serveBuilder(core: Core): Promise<number> {
  const err = useColor(process.stderr);
  const builder = startBuilder(core, {
    root: process.cwd(),
    onChange: (c) =>
      process.stderr.write(dim(c.active !== undefined ? `${c.active ? `the stack ${c.active}` : "the model"} answers now` : c.deleted ? `deleted the stack ${c.deleted}` : `saved the stack ${c.saved}${c.previous ? ` (was ${c.previous})` : ""}`, err) + "\n"),
  });
  const opened = openInBrowser(builder.url);
  console.log(`stack builder ${opened ? "opened in your browser" : "is up"}: ${builder.url}`);
  process.stderr.write(dim("on this machine only · what you save goes to the config · Ctrl+C stops it", err) + "\n");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  builder.stop();
  return EXIT.ok;
}

/** `kli init`: what this machine has (servers, CLIs, API keys) becomes the config, with stacks to start from. */
async function init(): Promise<number> {
  const color = useColor(process.stdout);
  const path = process.env.KLI_CONFIG || join(KLI_DIR, "config.json");
  const shown = path.startsWith(homedir() + "/") ? "~" + path.slice(homedir().length) : path;
  if (existsSync(path)) {
    console.log(`${shown} already exists, and kli uses it: /model adds sources, kli stackbuilder draws stacks.`);
    console.log(dim("To start over, move it away and run kli init again.", color));
    return EXIT.usage;
  }
  process.stderr.write(dim("looking at this machine…", useColor(process.stderr)) + "\n");
  const found = await lookAround();
  const lines: string[] = [];
  for (const [command, preset] of Object.entries(CLI_PRESETS))
    lines.push(found.clis.includes(command) ? `  ${green("✓", color)} ${preset.label} (${command})` : dim(`  · ${preset.label} (${command}): not on the PATH`, color));
  for (const s of SERVER_PORTS) {
    const server = found.servers.find((f) => f.name === s.name);
    if (!server) lines.push(dim(`  · ${s.label} on :${s.port}: not running`, color));
    else lines.push(`  ${green("✓", color)} ${s.label} on :${s.port} · ${server.models.length ? server.models.slice(0, 4).join(", ") + (server.models.length > 4 ? ", …" : "") : yellow("no models yet", color)}`);
  }
  for (const api of STARTER_APIS)
    lines.push(found.keys.includes(api.env) ? `  ${green("✓", color)} ${api.env}` : dim(`  · ${api.env}: not set`, color));
  console.log(bold("On this machine", color));
  console.log(lines.join("\n"));
  const config = starterConfig(found);
  if (!Object.keys(config.locations).length) {
    console.log("");
    console.log("Nothing to talk to yet. Any one of these is enough:");
    console.log("  · a local server: install Ollama (https://ollama.com) and run  ollama pull qwen3:4b");
    console.log("  · a CLI Kli knows, logged in: Claude Code (claude), Antigravity (agy), OpenCode (opencode), Kimi Code (kimi)");
    console.log("  · an API key in ~/.kli/.env: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY");
    console.log("Then run kli init again.");
    return EXIT.failure;
  }
  mkdirSync(dirname(path), { recursive: true });
  saveConfig(path, config);
  const stacks = Object.keys(config.stacks ?? {});
  console.log("");
  console.log(`${green("Wrote", color)} ${shown}`);
  if (config.model) console.log(`  model   ${config.model}${config.model.startsWith(`${HERE}/`) && found.clis.includes(config.model.split("/")[1]!) ? dim("  (a CLI works as an agent in the folder where kli runs; Shift+Tab: plan mode)", color) : ""}`);
  console.log(`  stacks  ${stacks.length ? stacks.join(", ") : dim("none: a stack needs two models (ollama pull another one, or log in to a second CLI)", color)}`);
  console.log("");
  console.log("Next:");
  const next: [string, string][] = [
    ["kli check", "say \"ok\" to each model and measure it"],
    ...(stacks.includes("compare") ? ([["kli --stack compare \"what is a golem?\"", "two models side by side"]] as [string, string][]) : []),
    ["kli", "a session here: /model, /stack, /help"],
    ["kli stackbuilder", "draw, test and save stacks in the browser"],
  ];
  const width = Math.max(...next.map(([c]) => c.length));
  for (const [c, what] of next) console.log(`  ${c.padEnd(width)}  ${dim(what, color)}`);
  return EXIT.ok;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "help":
      console.log(HELP);
      return EXIT.ok;
    case "version":
      console.log(pkg.version);
      return EXIT.ok;
    case "golem": {
      console.log(gallery(useColor(process.stdout)).join("\n"));
      return EXIT.ok;
    }
  }
  if (args.command === "init") return init();
  const core = openCore();
  if (args.command === "locations") return showLocations(core, args.json);
  if (args.command === "models") return showModels(core, args.id, args.json);
  if (args.command === "check") return showCheck(core, args.id, args.json);
  if (args.command === "sessions") return showSessions(core, args.id, args.json);
  if (args.command === "stats") return showStats(core, args);
  if (args.command === "stackbuilder") return serveBuilder(core);
  return prompt(core, args);
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    const color = useColor(process.stderr);
    if (e instanceof ArgsError || e instanceof ConfigError) {
      process.stderr.write(red(`kli: ${e.message}`, color) + "\n");
      process.exitCode = EXIT.usage;
    } else if (e instanceof ProviderError) {
      process.stderr.write(red(`kli: ${e.provider}: ${e.message}`, color) + "\n");
      process.exitCode = EXIT.failure;
    } else {
      process.stderr.write(red(`kli: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, color) + "\n");
      process.exitCode = EXIT.failure;
    }
  },
);
