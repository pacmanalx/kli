import { CLI_PRESETS, SERVER_PORTS } from "./presets.ts";
import { shellQuote, sshCommand, sshWhy } from "./tunnels.ts";
import type { MachineLocation, MachineProvider } from "./types.ts";

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * What a machine has: the servers on their usual ports (Ollama, llama.cpp, LM Studio, vLLM) and the CLIs Kli knows.
 * On another machine, the CLIs and the ports that only listen on localhost are found over ssh (they get a tunnel).
 */
export async function discover(location: MachineLocation): Promise<Record<string, MachineProvider>> {
  const found: Record<string, MachineProvider> = {};
  const host = location.host ?? "localhost";
  const remote = !!(location.host || location.ssh);
  const direct = await Promise.all(SERVER_PORTS.map((s) => (location.host || !remote ? answers(`http://${host}:${s.port}/v1/models`) : Promise.resolve(false))));
  SERVER_PORTS.forEach((s, i) => {
    if (direct[i]) found[s.name] = { type: "server", port: s.port };
  });
  const clis = Object.keys(CLI_PRESETS);
  if (!remote) {
    for (const c of clis) if (Bun.which(c)) found[c] = { type: "cli", command: c };
    return found;
  }
  if (!location.ssh && !location.host) return found;
  // one ssh round trip: which CLIs are on the PATH, which ports accept a connection on localhost
  const script = [
    `for c in ${clis.join(" ")}; do command -v "$c" >/dev/null 2>&1 && echo "cli $c"; done`,
    `for p in ${SERVER_PORTS.map((s) => s.port).join(" ")}; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo "port $p"; done`,
    "true", // a closed last port is not a failure of ssh
  ].join("; ");
  const [command, ...options] = sshCommand(location);
  const proc = Bun.spawn([Bun.which(command!) ?? command!, ...options, `bash -lc ${shellQuote(script)}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = setTimeout(() => proc.kill(), 20_000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(kill);
  if (code !== 0) {
    const why = sshWhy([command!, ...options], await new Response(proc.stderr).text());
    throw new Error(`ssh to ${options.at(-1)} failed${why ? `: ${why}` : ""}`);
  }
  for (const line of out.split("\n")) {
    const [kind, value] = line.trim().split(" ");
    if (kind === "cli" && value) found[value] = { type: "cli", command: value };
    const server = SERVER_PORTS.find((s) => String(s.port) === value);
    // reachable over the network already, or only on localhost there: through a tunnel
    if (kind === "port" && server && !found[server.name]) found[server.name] = { type: "server", port: server.port, tunnel: true };
  }
  return found;
}
