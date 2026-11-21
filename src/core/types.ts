export type Role = "system" | "user" | "assistant" | "tool";

/** A tool the model asked for: which one, with what input. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A chat message in the core's own format, independent of any provider. */
export interface Message {
  role: Role;
  content: string;
  /** An assistant's turn: the tools it asked for. */
  toolCalls?: ToolCall[];
  /** A tool's turn: which call it answers. */
  toolCallId?: string;
  toolName?: string;
  /** What a provider needs back as it came (Gemini's thought signatures); others ignore it. */
  raw?: { provider: string; parts: unknown[] };
}

interface ProviderBase {
  model: string;
  /** Extra request body fields, sent as they are (e.g. reasoning_effort "none" turns thinking off on Ollama). */
  extra?: Record<string, unknown>;
}

/** Any OpenAI-compatible chat API: llama-server, Ollama, vLLM, LM Studio, OpenAI, OpenRouter, Groq, DeepSeek... */
export interface OpenAIProviderConfig extends ProviderBase {
  type: "openai";
  /** API base URL, including /v1. */
  url: string;
  /** Name of the environment variable that holds the API key. The key itself never goes in the file. */
  apiKeyEnv?: string;
  /** Added to the system message for this server's models (e.g. "/no_think", which turns Nemotron's and Qwen3's thinking off). */
  instructions?: string;
}

/**
 * Vertex AI (Gemini Enterprise Agent Platform). The model is "publisher/model": google/* goes through the native
 * Gemini API; other publishers (deepseek-ai, qwen, openai...) go through Vertex's OpenAI-compatible endpoint.
 * Auth: Google Application Default Credentials (gcloud user or service account).
 */
export interface VertexProviderConfig extends ProviderBase {
  type: "vertex";
  project: string;
  /** "global" (default) or a region such as "us-central1". */
  location?: string;
  /** Path to a credentials JSON; defaults to the ADC chain. */
  credentials?: string;
  /** A Google API key instead of the credentials. */
  apiKeyEnv?: string;
  maxTokens?: number;
  /** Overrides the API host (tests, private endpoints). */
  url?: string;
}

/** Anthropic's Messages API (Claude). */
export interface AnthropicProviderConfig extends ProviderBase {
  type: "anthropic";
  /** Defaults to ANTHROPIC_API_KEY. */
  apiKeyEnv?: string;
  /** Defaults to https://api.anthropic.com. */
  url?: string;
  /** Required by the API; defaults to 4096. */
  maxTokens?: number;
}

/**
 * Another agent harness (Claude Code, Antigravity, OpenCode...) run non-interactively as a provider: Kli hands it the
 * conversation and reads the answer back. The harness keeps its own login, tools and permission system, so the
 * args decide how much of it is switched on.
 */
export interface HarnessProviderConfig extends Omit<ProviderBase, "extra"> {
  type: "harness";
  /** The executable, looked up on the PATH. */
  command: string;
  /** Arguments; "{prompt}" is replaced by the prompt (without it, the prompt goes to stdin) and "{model}" by the model. */
  args?: string[];
  /** How to read stdout: plain text, or the stream-json of Claude Code or Antigravity. Default: text. */
  format?: "text" | "claude" | "antigravity" | "opencode" | "kimi";
  /** Working directory; default ~/.kli/harness (a neutral place). "." = where kli runs. */
  cwd?: string;
  env?: Record<string, string>;
  /** Run it on another machine: the ssh command and options up to the destination. */
  ssh?: string[];
  /**
   * For the CLIs Kli knows: the arguments put in place of "{mode}" for each way it runs. As an agent it works in the
   * person's folder with its own tools; in plan mode it only reads; isolated (a test, another machine) it only answers.
   */
  modes?: { isolated: string[]; plan: string[]; agent: string[] };
}

/** How Kli talks to one model: what the providers below are built from (see core/locations.ts). */
export type ProviderConfig = OpenAIProviderConfig | VertexProviderConfig | AnthropicProviderConfig | HarnessProviderConfig;

/** A server on a machine: any OpenAI-compatible API (Ollama, llama.cpp, LM Studio, vLLM...). */
export interface ServerProvider {
  type: "server";
  /** Ollama 11434, llama.cpp 8080, LM Studio 1234, vLLM 8000. */
  port: number;
  /** The API path; default /v1. */
  path?: string;
  /** It only listens on localhost there: Kli reaches it through an SSH tunnel (needs the location's ssh). */
  tunnel?: boolean;
  /** Name of the variable with the key, when the server asks for one (the key goes in ~/.kli/.env). */
  apiKeyEnv?: string;
  /** The model used when none is named. */
  model?: string;
  extra?: Record<string, unknown>;
  /**
   * Added to the system message for this server's models: what a model needs that a request option cannot give.
   * The exo cluster's Nemotron, for one, only stops thinking out loud with "/no_think" there.
   */
  instructions?: string;
}

/**
 * Another CLI on a machine (Claude Code, Antigravity, OpenCode, Kimi...), run non-interactively. The ones Kli knows
 * come with their arguments (isolated, read-only); for any other, `args` says how to call it.
 */
export interface CliProvider {
  type: "cli";
  command: string;
  args?: string[];
  format?: HarnessProviderConfig["format"];
  /** Working directory; default ~/.kli/harness. "." = where kli runs (this machine only). */
  cwd?: string;
  env?: Record<string, string>;
  /** Empty: the CLI's own default model. */
  model?: string;
}

export type MachineProvider = ServerProvider | CliProvider;

/** This machine (no host) or another one, with the servers and CLIs it has. */
export interface MachineLocation {
  type: "machine";
  /** Address on the network; absent = this machine. */
  host?: string;
  /** "user@host" or an alias of ~/.ssh/config: runs the CLIs there and opens the tunnels. */
  ssh?: string;
  /** A machine to go through (ssh -J). */
  jump?: string;
  /** Extra ssh options (e.g. ["-o", "UserKnownHostsFile=..."]). */
  sshOptions?: string[];
  providers: Record<string, MachineProvider>;
}

/** Google's API (Vertex AI): Gemini, and the partners' models served there (DeepSeek, GLM, gpt-oss...). */
export interface GoogleLocation {
  type: "google";
  project: string;
  /** "global" (default) or a region such as "us-central1". */
  region?: string;
  /** Without a key, gcloud's login (Application Default Credentials). */
  apiKeyEnv?: string;
  credentials?: string;
  model?: string;
  maxTokens?: number;
  extra?: Record<string, unknown>;
  url?: string;
}

/** Anthropic's API (Claude). */
export interface AnthropicLocation {
  type: "anthropic";
  /** Default ANTHROPIC_API_KEY. */
  apiKeyEnv?: string;
  url?: string;
  model?: string;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}

/** Any OpenAI-compatible service on the internet: OpenAI, OpenRouter, DeepSeek, Groq... */
export interface ApiLocation {
  type: "api";
  /** Base URL, including /v1. */
  url: string;
  apiKeyEnv?: string;
  model?: string;
  extra?: Record<string, unknown>;
}

export type LocationConfig = MachineLocation | GoogleLocation | AnthropicLocation | ApiLocation;
export const LOCATION_TYPES = ["machine", "google", "anthropic", "api"] as const;

/**
 * What a node does: `answer` the prompt (or join the answers it gets), `aggregate` the answers it gets into one and
 * say how much came from each, `verify` them against the prompt (it only judges: it is not an answer of the stack),
 * `choose` one of them, which becomes the answer and the one the conversation goes on from, or `ground` the next
 * step: bring it context from data sources (it has no model; what it gets passes through it).
 */
export const NODE_ROLES = ["answer", "aggregate", "verify", "choose", "ground"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/**
 * Who chooses, in the order to try: a `model` (the node's), the `person` (on the full screen), or a `decision` model
 * trained to choose (none is good enough yet, so it is passed over for now).
 */
export const CHOOSERS = ["model", "person", "decision"] as const;
export type Chooser = (typeof CHOOSERS)[number];

/** How a grounding node's context is used: added to what the model knows, or the only thing it answers from. */
export const GROUND_MODES = ["enrich", "restrict"] as const;
export type GroundMode = (typeof GROUND_MODES)[number];
/** What a grounding node searches with: the prompt, the answers it gets, or both. */
export const GROUND_QUERIES = ["request", "answers", "both"] as const;
export type GroundQuery = (typeof GROUND_QUERIES)[number];
/** What a grounding node hides in the excerpts before they go to a model. */
export const MASKS = ["email", "cpf", "phone"] as const;
export type Mask = (typeof MASKS)[number];

/** One step of a stack: a model that gets the prompt, or the answers of the steps before it. */
export interface StackNode {
  /** "location/provider/model"; a grounding node has none. */
  model?: string;
  /** Default "answer". */
  role?: NodeRole;
  /** To choose: who chooses, the first one that can (default ["model"]). */
  by?: Chooser[];
  /** The nodes whose answers this one gets; none = it gets the prompt. */
  from?: string[];
  /** Added to the config's instructions for this node. */
  instructions?: string;
  /**
   * Kli's tools for this node: only the ones that read, none, or `write` (to answer only): it works in a copy of the
   * folder of its own, and the person chooses which changes to apply. Default: read to answer, none to aggregate or
   * verify. A CLI uses its own: in plan mode to read, as an agent in its copy to write.
   */
  tools?: "read" | "none" | "write";
  /** Shown as a result of the stack. Default: the nodes no other node gets from. */
  output?: boolean;
  /** How many of its inputs must answer for it to run (default 1). */
  min?: number;
  /** Tried in order when its model fails before answering. The config's fallback is not used in a stack. */
  fallback?: string[];
  /** To verify: requirements judged every time, besides the ones the verifier reads in the request. */
  requirements?: string[];
  /** To ground: the data sources it searches (names in the config's `sources`). */
  sources?: string[];
  /** To ground: enrich (the default) or restrict. */
  mode?: GroundMode;
  /** To ground: what it searches with (default "request"). */
  query?: GroundQuery;
  /** To ground: the person's rules, over the mode's. */
  rules?: string;
  /** To ground: files that always go in whole, before the excerpts (a glossary, a policy). */
  attach?: string[];
  /** To ground: most tokens of context it passes on (default 2000); the least relevant excerpts are left out. */
  budget?: number;
  /** To ground: most excerpts from each source (default 8). */
  top?: number;
  /** To ground: what is hidden in the excerpts. */
  mask?: Mask[];
}

/** A data source a grounding node searches: local files (text, Markdown, CSV, JSON). More types come one at a time. */
export interface FilesSource {
  type: "files";
  /** Files, folders or globs ("~/docs/**\/*.md"); a folder is everything readable in it. */
  paths: string[];
}
export type SourceConfig = FilesSource;
export const SOURCE_TYPES = ["files"] as const;

/** A graph of models: the prompt goes to the nodes without inputs, and each other node joins the ones it gets from. */
export interface StackConfig {
  description?: string;
  /**
   * The work the stack is for, in words ("implementing, fixing or reviewing the project's code"). With it and the
   * config's `triage`, a message that asks for something else (a question, thanks, a quick command) goes to one model;
   * without it, the stack takes every message.
   */
  purpose?: string;
  nodes: Record<string, StackNode>;
  /** For the nodes that write: in the folder (the only one), or each in its own copy of it (two or more). */
  write?: {
    /** From older versions, ignored: a copy has the folder's dependencies already, so nothing is set up. */
    setup?: string;
    /** Commands the nodes may run besides the ones that only read; each allows the ones that start with it ("bun test"). */
    run?: string[];
    /** Run where a node worked when it ends, if it changed files (the tests): passed or failed goes to the results, and a verifier counts it. */
    check?: string;
    /**
     * The box the nodes' commands and the check run in (core/fence.ts): they write only in the copy, the temporary
     * folders and the tools' caches, and reach no network but this machine's. `network` lets them reach it, `write`
     * adds folders they may write in, and false turns the fence off.
     */
    fence?: false | { network?: boolean; write?: string[] };
  };
}

export interface Config {
  /** Who is using it. Defaults to the OS user. */
  user?: string;
  /** Where inference runs: location → provider → model. */
  locations: Record<string, LocationConfig>;
  /** The model a session starts on: "location/provider/model" ("location/model" for an API). */
  model?: string;
  /** Tried in order when the model fails before sending any text. */
  fallback?: string[];
  /** The stacks the person built (`/stack` chooses one). */
  stacks?: Record<string, StackConfig>;
  /** The stack that answers; none = the model does. */
  stack?: string;
  /**
   * Before a stack with a `purpose` runs, this small, fast model reads the message and says whether it asks for the
   * stack's work; if not, the model answers it alone. Its answer that cannot be read, or its failure, lets the stack run.
   */
  triage?: { model: string };
  /** Data sources the grounding nodes of any stack search: declared once (data, not inference). */
  sources?: Record<string, SourceConfig>;
  /** System instructions for every conversation. */
  instructions?: string;
  temperature?: number;
  sessions?: {
    dir?: string;
    /** Store prompt and response text, not just measurements. Default: true. */
    content?: boolean;
  };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A provider failure. `afterText` tells whether any text had already reached the user. */
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly provider: string,
    message: string,
    readonly afterText = false,
    readonly status?: number,
  ) {
    super(message);
  }
}
