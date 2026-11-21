import type { HarnessProviderConfig } from "./types.ts";

/**
 * Antigravity in plan mode does nothing that would ask: no commands, MCP tools or URLs. With -p, what its own rules
 * do not allow is refused and the run ends there, with only what it said it would do (12/11/2026: a `git log`, then
 * a search in an MCP server, ended the plan at "I'll read…"). A rule that denies them goes back to the model as an
 * error instead, and it goes on reading with its own tools.
 */
const AGY_ASKS_NOTHING = ["--settings", JSON.stringify({ permissions: { deny: ["command(*)", "mcp(*)", "read_url(*)", "execute_url(*)"] } })];

/**
 * How Kli runs the CLIs it knows, without interaction, with the model in the arguments ("{model}"; with no model, the
 * flag before it is left out and the CLI uses its own default). "{mode}" takes the arguments of the way it runs: as an
 * agent, in the person's folder with its own tools and permissions (whoever installed the CLI and chose it gave it
 * that permission); in plan mode, only reading; isolated (a test, another machine), only answering.
 */
export const CLI_PRESETS: Record<
  string,
  { args: string[]; format: NonNullable<HarnessProviderConfig["format"]>; label: string; modes: NonNullable<HarnessProviderConfig["modes"]> }
> = {
  claude: {
    label: "Claude Code",
    args: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "{mode}", "--model", "{model}"],
    format: "claude",
    // isolated: no tools, no MCP servers, none of the person's settings or hooks
    modes: { isolated: ["--tools", "", "--strict-mcp-config", "--setting-sources", "project"], plan: ["--permission-mode", "plan"], agent: ["--dangerously-skip-permissions"] },
  },
  agy: {
    label: "Antigravity",
    args: ["-p", "{prompt}", "--output-format", "stream-json", "{mode}", "--model", "{model}"],
    format: "antigravity",
    modes: { isolated: ["--mode", "plan", "--sandbox", ...AGY_ASKS_NOTHING], plan: ["--mode", "plan", ...AGY_ASKS_NOTHING], agent: ["--dangerously-skip-permissions"] },
  },
  opencode: {
    label: "OpenCode",
    args: ["run", "--format", "json", "{mode}", "-m", "{model}", "{prompt}"],
    format: "opencode",
    modes: { isolated: ["--agent", "plan"], plan: ["--agent", "plan"], agent: ["--auto"] },
  },
  // prompt mode already acts on its own, and takes neither --auto, --yolo nor --plan: plan mode runs it isolated
  kimi: {
    label: "Kimi Code",
    args: ["-p", "{prompt}", "--output-format", "stream-json", "{mode}", "-m", "{model}"],
    format: "kimi",
    modes: { isolated: [], plan: [], agent: [] },
  },
};

/** The servers Kli looks for on a machine, by their usual port. */
export const SERVER_PORTS: { port: number; name: string; label: string }[] = [
  { port: 11434, name: "ollama", label: "Ollama" },
  { port: 8080, name: "llama.cpp", label: "llama.cpp" },
  { port: 1234, name: "lmstudio", label: "LM Studio" },
  { port: 8000, name: "vllm", label: "vLLM" },
];
