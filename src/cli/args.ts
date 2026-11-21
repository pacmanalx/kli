/** Names follow the market harnesses (Claude Code, Codex, OpenCode, Gemini CLI). */
export type Command = "prompt" | "init" | "locations" | "models" | "check" | "sessions" | "stats" | "stackbuilder" | "golem" | "help" | "version";

export interface Args {
  command: Command;
  prompt?: string;
  /** Session id for `kli sessions <id>`; location, provider or model for `kli models` and `kli check`. */
  id?: string;
  /** `-m`: the model to use, "location/provider/model". */
  model?: string;
  /** `--stack`: the stack that answers this time (instead of the config's stack or model). */
  stack?: string;
  /** `kli stats --days N`: how far back to look. */
  days?: number;
  /** What the tools may do without asking (as in Claude Code): default, acceptEdits or plan. */
  permissionMode?: "default" | "acceptEdits" | "plan";
  /** `-p`: answer and exit, never start an interactive session. */
  print: boolean;
  json: boolean;
}

export class ArgsError extends Error {
  override name = "ArgsError";
}

/** How many words each subcommand takes after it. */
const SUBCOMMANDS: Partial<Record<Command, number>> = { init: 0, locations: 0, models: 1, check: 1, sessions: 1, stats: 0, stackbuilder: 0, golem: 0 };

/** `kli [options] [prompt...]` or `kli init | locations | models [where] | check [where] | sessions [id] | stats | stackbuilder | golem`. */
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let json = false;
  let print = false;
  let model: string | undefined;
  let stack: string | undefined;
  let days: number | undefined;
  let permissionMode: Args["permissionMode"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") return { command: "help", print, json };
    if (a === "-v" || a === "--version") return { command: "version", print, json };
    if (a === "--json") json = true;
    else if (a === "-p" || a === "--print") print = true;
    else if (a === "-m" || a === "--model") {
      model = argv[++i];
      if (!model) throw new ArgsError("--model needs a model (e.g. --model mac/ollama/lfm3)");
    } else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--stack" || a.startsWith("--stack=")) {
      stack = a === "--stack" ? argv[++i] : a.slice("--stack=".length);
      if (!stack) throw new ArgsError("--stack needs the name of a stack");
    }
    else if (a === "--provider" || a.startsWith("--provider=") || a === "--profile" || a.startsWith("--profile="))
      throw new ArgsError(`${a.split("=")[0]} is gone: choose with --model location/provider/model (kli locations lists them)`);
    else if (a === "--permission-mode" || a.startsWith("--permission-mode=")) {
      const value = a === "--permission-mode" ? argv[++i] : a.slice("--permission-mode=".length);
      if (value !== "default" && value !== "acceptEdits" && value !== "plan") throw new ArgsError("--permission-mode is default, acceptEdits or plan");
      permissionMode = value;
    } else if (a === "--days" || a.startsWith("--days=")) {
      const value = a === "--days" ? argv[++i] : a.slice("--days=".length);
      days = Number(value);
      if (!Number.isInteger(days) || days < 1) throw new ArgsError("--days needs a whole number of days (e.g. --days 7)");
    } else if (a.startsWith("-") && a.length > 1) throw new ArgsError(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (model && stack) throw new ArgsError("--model and --stack: choose one (a stack has its own models)");
  const [first, ...rest] = positional;
  const takes = first ? SUBCOMMANDS[first as Command] : undefined;
  if (!print && takes !== undefined && rest.length <= takes) return { command: first as Command, id: rest[0], model, days, print, json, ...(stack && { stack }), ...(permissionMode && { permissionMode }) };
  return { command: "prompt", prompt: positional.join(" ") || undefined, model, days, print, json, ...(stack && { stack }), ...(permissionMode && { permissionMode }) };
}

/** Piped input becomes context for the prompt; with no prompt, it is the prompt. */
export function buildPrompt(prompt: string | undefined, input: string): string {
  const context = input.trim();
  if (!context) return prompt?.trim() ?? "";
  if (!prompt?.trim()) return context;
  return `<input>\n${context}\n</input>\n\n${prompt.trim()}`;
}

export const HELP = `kli

Usage:
  kli "prompt"            answer and exit
  kli                     start an interactive session
  cat x | kli "prompt"    piped input becomes context
  kli init                find the CLIs and local servers on this machine and write a config with example stacks
  kli locations           where inference runs: locations, their providers, credentials
  kli models [where]      the models a location or provider offers (kli models mac/ollama)
  kli check [where]       send a one-word prompt to each provider's model (or to one)
  kli sessions [id]       list recent sessions, or show one session's trace
  kli stats [--days N]    charts from the traces: outcomes, latency and tokens by model, answers per day
  kli stackbuilder        a page in the browser to draw the stacks as graphs, test them and save them
  kli golem               show the mascot and its poses

Options:
  -m, --model <model>     use this model this time: location/provider/model (e.g. mac/ollama/lfm3); /model sets the default
      --stack <name>      let this stack answer this time (the config's "stack" answers when there is one)
  -p, --print             answer and exit, never start a session
      --permission-mode <m>  default (ask before writing or running), acceptEdits (file edits without asking), plan (read only)
      --json              machine-readable output
  -h, --help              show this help
  -v, --version           show the version

In a session: /model [name] · /stats · /new (or /clear) · /status · /help · /exit (or /quit) · Esc/Ctrl+C stops the response
Tools: Read, Glob and Grep freely in the folder where kli runs; Write, Edit and Bash ask first (Shift+Tab: accept edits, plan)

Config: $KLI_CONFIG, ./kli.json or ~/.kli/config.json (kli init writes one) · API keys: ~/.kli/.env ($KLI_ENV)
KLI_ANIMATION=off keeps the golem still · KLI_THEME=light|dark forces the chart palette
Sessions: ~/.kli/sessions/<id>.jsonl`;
