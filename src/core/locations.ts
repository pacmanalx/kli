import { basename } from "node:path";
import { CLI_PRESETS } from "./presets.ts";
import { sshCommand, type Tunnels } from "./tunnels.ts";
import { ConfigError, type Config, type LocationConfig, type MachineLocation, type ProviderConfig } from "./types.ts";

/**
 * A model, named the way the person sees it: location → provider → model. On a machine the provider is one of its
 * servers or CLIs ("mac/ollama/lfm3", "gpubox/claude/sonnet"). On an API the provider is whoever made the model, the
 * first part of the API's own id ("vertex/deepseek-ai/deepseek-v4.1-flash-maas"); a model with no maker in its id is
 * just "anthropic/claude-sonnet-5-5".
 */
export interface Target {
  /** The full name: `${label}/${model}`. */
  ref: string;
  location: string;
  /** The machine's server or CLI, or the maker on an API (undefined when the id has none). */
  provider?: string;
  /** What goes to the server, the API or the CLI. Empty: a CLI's own default. */
  model: string;
  /** Who answered, in the trace and on screen: "mac/ollama" on a machine, the location on an API. */
  label: string;
}

export const isMachine = (l: LocationConfig): l is MachineLocation => l.type === "machine";

/** On Google's API a model with no maker is one of Google's own. */
const googleId = (model: string) => (model && !model.includes("/") ? `google/${model}` : model);

/** Reads "location/provider/model" (or shorter, falling back on the defaults). Throws a ConfigError saying what is missing. */
export function resolveRef(config: Config, ref: string): Target {
  const [name, ...rest] = ref.trim().split("/");
  const location = name ? config.locations[name] : undefined;
  if (!name || !location) throw new ConfigError(`location "${name}" is not declared`);
  if (isMachine(location)) {
    const names = Object.keys(location.providers);
    const provider = rest[0] || (names.length === 1 ? names[0] : undefined);
    if (!provider) throw new ConfigError(`${name} has ${names.length ? names.join(", ") : "no providers"}: say which (${name}/<provider>/<model>)`);
    const p = location.providers[provider];
    if (!p) throw new ConfigError(`${name} has no provider "${provider}"`);
    const model = rest.slice(1).join("/") || p.model || "";
    if (!model && p.type === "server") throw new ConfigError(`${name}/${provider} has no default model: name one (${name}/${provider}/<model>)`);
    const label = `${name}/${provider}`;
    return { ref: model ? `${label}/${model}` : label, location: name, provider, model, label };
  }
  let model = rest.join("/") || location.model || "";
  if (location.type === "google") model = googleId(model);
  if (!model) throw new ConfigError(`${name} has no default model: name one (${name}/<model>)`);
  return { ref: `${name}/${model}`, location: name, provider: model.includes("/") ? model.split("/", 1)[0] : undefined, model, label: name };
}

/** The models a location's or provider's default points to ("mac/ollama/lfm3"), when it has one. */
export function defaultRef(config: Config, location: string, provider?: string): string | undefined {
  try {
    return resolveRef(config, provider ? `${location}/${provider}` : location).ref;
  } catch {
    return undefined;
  }
}

/** Whether the target is a server reached through an SSH tunnel. */
function tunneled(config: Config, target: Target): { location: MachineLocation; port: number } | undefined {
  const location = config.locations[target.location]!;
  if (!isMachine(location) || !(location.host || location.ssh)) return;
  const p = location.providers[target.provider!]!;
  if (p.type === "server" && p.tunnel) return { location, port: p.port };
}

/**
 * The connection for a target, in the form the providers take. A server that only listens on localhost on another
 * machine gets its tunnel opened here.
 */
export async function connection(config: Config, target: Target, tunnels?: Tunnels): Promise<ProviderConfig> {
  const tunnel = tunneled(config, target);
  if (tunnel && !tunnels) throw new ConfigError(`${target.label} needs a tunnel`);
  return connectionNow(config, target, tunnel ? await tunnels!.port(tunnel.location, tunnel.port) : undefined);
}

/** The connection built without opening anything: a tunneled server shows where the tunnel goes, unless its local port is given. */
export function connectionNow(config: Config, target: Target, tunnelPort?: number): ProviderConfig {
  const location = config.locations[target.location]!;
  switch (location.type) {
    case "machine": {
      const p = location.providers[target.provider!]!;
      if (p.type === "server") {
        let base = `http://${location.host ?? "localhost"}:${p.port}`;
        if (tunneled(config, target)) base = tunnelPort ? `http://127.0.0.1:${tunnelPort}` : `ssh://${location.ssh ?? location.host}:${p.port}`;
        return { type: "openai", url: `${base}${p.path ?? "/v1"}`, model: target.model, apiKeyEnv: p.apiKeyEnv, extra: p.extra, ...(p.instructions && { instructions: p.instructions }) };
      }
      const preset = CLI_PRESETS[basename(p.command)];
      const remote = !!(location.host || location.ssh);
      return {
        type: "harness",
        command: p.command,
        args: p.args ?? preset?.args ?? ["{prompt}"],
        format: p.format ?? preset?.format ?? "text",
        model: target.model,
        cwd: p.cwd,
        env: p.env,
        // a CLI with its own arguments runs as they say; one Kli knows runs as an agent, in plan mode or isolated
        ...(!p.args && preset && { modes: preset.modes }),
        ...(remote && { ssh: sshCommand(location) }),
      };
    }
    case "google":
      return {
        type: "vertex",
        project: location.project,
        location: location.region ?? "global",
        credentials: location.credentials,
        apiKeyEnv: location.apiKeyEnv,
        url: location.url,
        model: target.model,
        maxTokens: location.maxTokens,
        extra: location.extra,
      };
    case "anthropic":
      return { type: "anthropic", apiKeyEnv: location.apiKeyEnv, url: location.url, model: target.model, maxTokens: location.maxTokens, extra: location.extra };
    case "api":
      return { type: "openai", url: location.url, apiKeyEnv: location.apiKeyEnv, model: target.model, extra: location.extra };
  }
}

/** One line about where a location is: "this machine", "192.168.10.230 via bastion", "Google API · project"... */
export function describeLocation(location: LocationConfig): string {
  switch (location.type) {
    case "machine":
      if (!location.host && !location.ssh) return "this machine";
      return [location.host, location.ssh && location.ssh !== location.host ? `ssh ${location.ssh}` : "", location.jump ? `via ${location.jump}` : ""].filter(Boolean).join(" · ");
    case "google":
      return `Google API · ${location.project} · ${location.region ?? "global"}`;
    case "anthropic":
      return "Anthropic API";
    case "api":
      try {
        return `API · ${new URL(location.url).host}`;
      } catch {
        return "API";
      }
  }
}
