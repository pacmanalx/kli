import { userInfo } from "node:os";
import { join } from "node:path";
import { KLI_DIR, putSource, putStack, removeSource, removeStack, saveConfig, setModel, setStack, setTriage } from "./config.ts";
import { connection, connectionNow, isMachine, resolveRef, type Target } from "./locations.ts";
import { createProvider, describeProvider, type ProviderFactory, type ProviderInfo } from "./providers/index.ts";
import { listModels, type ModelInfo } from "./providers/models.ts";
import { Router } from "./router.ts";
import { openSource, sourceProblems, type Excerpt } from "./sources/index.ts";
import { Session } from "./session.ts";
import { stackProblems } from "./stack.ts";
import { StackRunner } from "./stack-run.ts";
import type { Workspace } from "./tools.ts";
import { Trace } from "./trace.ts";
import { ConfigError, type Config, type ProviderConfig, type SourceConfig, type StackConfig } from "./types.ts";

/** Kli's core, kept apart from the terminal surface. */
export class Core {
  readonly router: Router;
  readonly sessionsDir: string;
  readonly user: string;

  constructor(
    private current: Config,
    /** The file the config came from: where the editor saves. */
    readonly configPath?: string,
    /** Makes the providers (tests give fake ones). */
    factory?: ProviderFactory,
  ) {
    this.router = new Router(current, factory);
    this.sessionsDir = current.sessions?.dir ?? join(KLI_DIR, "sessions");
    this.user = current.user ?? userInfo().username;
  }

  get config(): Config {
    return this.current;
  }

  /** Saves an edited config to its file and starts using it; open sessions keep their history. */
  apply(config: Config): void {
    if (!this.configPath) throw new ConfigError("this config was not loaded from a file, so it cannot be saved");
    saveConfig(this.configPath, config);
    this.current = config;
    this.router.reconfigure(config);
  }

  /** The connection of a model, as the providers take it (`config` for one not saved yet: the editor's Test). */
  connection(target: Target, config = this.config): Promise<ProviderConfig> {
    return connection(config, target, this.router.tunnels);
  }

  /** Which credentials a model would use and whether they are there, checked locally (a tunnel is not opened). */
  describe(ref: string, config = this.config): ProviderInfo & { target: Target } {
    const target = resolveRef(config, ref);
    return { ...describeProvider(connectionNow(config, target)), target };
  }

  /**
   * Sends a fixed one-word prompt to a model: is it configured, reachable and answering? With `config`, tests one
   * that is not saved yet (the editor's Test).
   */
  async check(ref: string, config = this.config): Promise<{ ok: boolean; skipped?: boolean; ms?: number; reply?: string; error?: string; target?: Target }> {
    let target: Target;
    let info: ProviderInfo;
    try {
      ({ target, ...info } = this.describe(ref, config));
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!info.ready) return { ok: false, skipped: true, error: info.auth, target };
    const started = performance.now();
    try {
      const provider = config === this.config ? await this.router.connect(target) : createProvider(target.label, await this.connection(target, config));
      const r = await provider.chat({ messages: [{ role: "user", content: "Reply with just the word: ok" }], signal: AbortSignal.timeout(45_000) });
      return { ok: true, ms: Math.round(performance.now() - started), reply: r.text.trim(), target };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - started), error: (e as Error).message, target };
    }
  }

  /** What a location's provider offers ("mac/ollama", "vertex"), from the server, the API or the CLI. */
  async models(ref: string, config = this.config, signal?: AbortSignal): Promise<ModelInfo[]> {
    const [location, provider] = ref.split("/");
    const l = config.locations[location!];
    if (!l) throw new ConfigError(`location "${location}" is not declared`);
    // a placeholder model: only the connection matters for listing
    const target: Target = isMachine(l)
      ? { ...resolveProvider(config, location!, provider), model: "x" }
      : { ref: location!, location: location!, model: l.type === "google" ? "google/x" : "x", label: location! };
    return listModels(await this.connection(target, config), signal);
  }

  /** Whether a location's credentials are there (a key, gcloud's login); a machine always is. */
  status(location: string, config = this.config): { ready: boolean; auth: string } {
    const l = config.locations[location];
    if (!l) throw new ConfigError(`location "${location}" is not declared`);
    if (isMachine(l)) return { ready: true, auth: "" };
    const info = describeProvider(connectionNow(config, { ref: location, location, model: "x", label: location }));
    return { ready: info.ready, auth: info.auth };
  }

  /** The model a session starts on: the config's. */
  defaultModel(): string {
    return this.router.defaultModel();
  }

  /** Makes `ref` the default model, in the config file: the next sessions start on it (kli "..." too). */
  setDefaultModel(ref: string): string {
    const next = setModel(this.config, ref);
    this.apply(next);
    return next.model!;
  }

  /** Makes `name` the stack that answers, in the config file; none = the model answers again. */
  setStack(name?: string): void {
    this.apply(setStack(this.config, name));
  }

  /** Makes `ref` the triage model, in the config file; none = the stacks take every message. */
  setTriage(ref?: string): string | undefined {
    const next = setTriage(this.config, ref);
    this.apply(next);
    return next.triage?.model;
  }

  /** Saves a stack in the config file (renamed from `previous`). */
  saveStack(name: string, stack: StackConfig, previous?: string): void {
    this.apply(putStack(this.config, name, stack, previous));
  }

  /** Takes a stack out of the config file; when it was the one answering, the model answers again. */
  deleteStack(name: string): void {
    this.apply(removeStack(this.config, name));
  }

  /** Writes a data source into the config file (renaming `previous`: the grounding nodes follow). */
  saveSource(name: string, source: SourceConfig, previous?: string): void {
    this.apply(putSource(this.config, name, source, previous));
  }

  /** Takes a data source out of the config file; refused while a grounding node searches it. */
  deleteSource(name: string): void {
    this.apply(removeSource(this.config, name));
  }

  /** A search in a data source as it would be in a grounding node: what it finds for `query`, and how long it took. */
  async testSource(source: SourceConfig, query: string, top = 8): Promise<{ excerpts: Excerpt[]; ms: number }> {
    const problems = sourceProblems({ test: source });
    if (problems.length) throw new ConfigError(problems.join("; ").replace('source "test": ', ""));
    const started = performance.now();
    const excerpts = await openSource("test", source).search(query, top);
    return { excerpts, ms: Math.round(performance.now() - started) };
  }

  /** The nodes whose model (or fallback) the config does not have: the stack still loads, but they would fail. */
  stackModelProblems(stack: StackConfig): string[] {
    const problems: string[] = [];
    for (const [id, node] of Object.entries(stack.nodes ?? {})) {
      // a grounding node has no model: what it needs is its sources
      for (const s of node.role === "ground" ? (node.sources ?? []) : []) if (!this.config.sources?.[s]) problems.push(`node "${id}": "${s}" is not one of the config's sources`);
      for (const ref of [node.model, ...(node.fallback ?? [])])
        try {
          if (ref) this.router.target(ref);
        } catch (e) {
          problems.push(`node "${id}": ${(e as Error).message}`);
        }
    }
    return problems;
  }

  /** A new trace: one file per session, whoever answers in it (the model, a stack). */
  trace(surface = "cli"): Trace {
    return new Trace(this.sessionsDir, { user: this.user, surface }, this.config.sessions?.content ?? true);
  }

  /** A stack ready to take prompts; with `root`, its nodes read the files there. */
  stack(name: string, surface = "cli", root?: string, trace = this.trace(surface)): StackRunner {
    const stack = this.config.stacks?.[name];
    if (!stack) {
      const names = Object.keys(this.config.stacks ?? {});
      throw new ConfigError(`stack "${name}" is not one of the stacks${names.length ? ` (${names.join(", ")})` : " (there are none yet)"}`);
    }
    return new StackRunner(this.router, trace, name, stack, { instructions: this.config.instructions, root, sources: this.config.sources, triage: () => this.config.triage?.model });
  }

  /** A stack that is not saved yet (the builder's Test): its shape must be right; its models are checked as it runs. */
  draftStack(name: string, stack: StackConfig, surface = "cli", root?: string, trace = this.trace(surface)): StackRunner {
    const problems = stackProblems(name, stack);
    if (problems.length) throw new ConfigError(problems.join("\n"));
    return new StackRunner(this.router, trace, name, stack, { instructions: this.config.instructions, root, sources: this.config.sources });
  }

  /** A new conversation; with a workspace, the model gets the tools to work on its files. */
  session(surface = "cli", workspace?: Workspace, trace = this.trace(surface)): Session {
    return new Session(this.router, trace, this.config.instructions, workspace);
  }
}

/** A machine's provider as a target with no model yet. */
function resolveProvider(config: Config, location: string, provider?: string): Target {
  const l = config.locations[location];
  if (!l || !isMachine(l)) throw new ConfigError(`location "${location}" is not a machine`);
  const names = Object.keys(l.providers);
  const name = provider ?? (names.length === 1 ? names[0] : undefined);
  if (!name || !l.providers[name]) throw new ConfigError(`${location} has no provider "${provider ?? ""}"`);
  return { ref: `${location}/${name}`, location, provider: name, model: "", label: `${location}/${name}` };
}

export { findConfig, KLI_DIR, loadConfig, putLocation, putProvider, putSource, putStack, removeLocation, removeProvider, removeSource, removeStack, saveConfig, setModel, setStack, setTriage, validateConfig } from "./config.ts";
export { HERE, lookAround, starterConfig, STARTER_APIS, type Found } from "./starter.ts";
export type { Excerpt } from "./sources/index.ts";
export { adherence, joinPrompt, nodeModel, readContributions, readVerdict, stackOrder, stackOutputs, stackProblems, writesInFolder, type Grounding, type Mark, type Verdict } from "./stack.ts";
export type { GroundResult } from "./ground.ts";
export { heardNote, readTriage, triage, triageInput, triageMessages, type Exchange, type Route, type TriageResult } from "./triage.ts";
export { StackRunner, WAITING, type ChoiceRequest, type NodeResult, type StackEvent, type StackOptions, type StackResult } from "./stack-run.ts";
export type { Changes, CommandResult } from "./copies.ts";
export { discover } from "./discover.ts";
export { defaultRef, describeLocation, isMachine, resolveRef, type Target } from "./locations.ts";
export { CLI_PRESETS, SERVER_PORTS } from "./presets.ts";
export { listModels, type ModelInfo } from "./providers/models.ts";
export type { RoutedResponse } from "./router.ts";
export { envFile, envFileWarning, masked, saveSecret, secret, secretSource, withSecret } from "./secrets.ts";
export { collectStats, type ProviderStats, type Stats } from "./stats.ts";
export { listSessions, readTrace, type NodeStatus, type StoredEvent, type TraceEvent } from "./trace.ts";
export { MODES, TOOL_SPECS, Workspace, type Answer, type PermissionMode, type PermissionRequest, type ToolResult } from "./tools.ts";
export type { ToolEvent } from "./session.ts";
export { lineDiff, type DiffLine } from "./diff.ts";
export { cutMiddle, duration, Job, plainText } from "./jobs.ts";
export { describeRules, parseCommand, ruleFor, type CommandRule } from "./shell.ts";
export { INSTRUCTION_FILES, type InstructionFile } from "./instructions.ts";
export type { ProviderInfo } from "./providers/index.ts";
export { ConfigError, ProviderError, type Config, type LocationConfig, type MachineProvider, type ProviderConfig, type Chooser, type NodeRole, type SourceConfig, type StackConfig, type StackNode } from "./types.ts";
