import type { Subprocess } from "bun";
import type { MachineLocation } from "./types.ts";

/** The ssh command up to the destination: `ssh [options] [-J jump] user@host`. $KLI_SSH replaces ssh (tests). */
export function sshCommand(location: MachineLocation): string[] {
  const target = location.ssh ?? location.host;
  if (!target) throw new Error("this location has no ssh: set its SSH (user@host)");
  return [
    process.env.KLI_SSH ?? "ssh",
    "-o", "BatchMode=yes", // never wait for a password: keys only
    "-o", "ConnectTimeout=10",
    ...(location.jump ? ["-J", location.jump] : []),
    ...(location.sshOptions ?? []),
    target,
  ];
}

/** A word for a remote shell, quoted. */
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/**
 * Why ssh failed: the last line it printed, and what to do when it is the machine's key. With BatchMode ssh never
 * asks to trust a machine, so the first connection to it has to be made by hand, once.
 */
export function sshWhy(ssh: string[], stderr: string): string | undefined {
  const why = stderr.trim().split("\n").filter(Boolean).at(-1);
  if (!why?.includes("Host key verification failed")) return why;
  const target = ssh.at(-1)!;
  const changed = /Host key for (\S+) has changed/.exec(stderr);
  if (changed || stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED"))
    return `the key of ${changed?.[1] ?? target} is not the one in ~/.ssh/known_hosts. If that machine was reinstalled, remove the old key (ssh-keygen -R ${changed?.[1] ?? target.replace(/^.*@/, "")}) and connect once by hand; if not, someone may be in the way`;
  // the same ssh, but one that may ask
  const byHand = ["ssh"];
  for (let i = 1; i < ssh.length; i++) {
    if (ssh[i] === "-o" && /^(BatchMode|ConnectTimeout)=/.test(ssh[i + 1] ?? "")) i++;
    else byHand.push(ssh[i]!);
  }
  return `the key of ${target} is not in ~/.ssh/known_hosts yet, and Kli's ssh never asks. Accept it once by hand, checking the fingerprint: ${[...byHand, "true"].map(shellQuote).join(" ")} (in a Kli session, start it with !)`;
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function accepts(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * SSH tunnels to servers that only listen on localhost on their machine, opened when first needed and kept while
 * Kli runs (one per machine and port).
 */
export class Tunnels {
  private readonly open = new Map<string, Promise<number>>();
  private readonly processes: Subprocess[] = [];

  constructor() {
    process.once("exit", () => this.close());
  }

  /** The local port that reaches `port` on the machine. */
  port(location: MachineLocation, port: number): Promise<number> {
    const ssh = sshCommand(location);
    const key = `${ssh.join(" ")}:${port}`;
    let local = this.open.get(key);
    if (!local) {
      // a failure is tried again next time, and so is a tunnel whose ssh ended later (the Mac slept, the network fell)
      const forget = () => {
        if (this.open.get(key) === local) this.open.delete(key);
      };
      local = this.start(ssh, port, forget);
      this.open.set(key, local);
      local.catch(forget);
    }
    return local;
  }

  private async start(ssh: string[], port: number, ended: () => void): Promise<number> {
    const local = await freePort();
    const [command, ...options] = ssh;
    // a connection that died while the Mac slept ends the ssh, instead of keeping a port that reaches nothing
    const alive = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
    const proc = Bun.spawn([command!, "-N", "-o", "ExitOnForwardFailure=yes", ...alive, "-L", `127.0.0.1:${local}:127.0.0.1:${port}`, ...options], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    proc.unref(); // the tunnel never keeps Kli running
    void proc.exited.then(ended);
    this.processes.push(proc);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        const why = sshWhy(ssh, await new Response(proc.stderr).text());
        throw new Error(`ssh tunnel to ${ssh.at(-1)} failed${why ? `: ${why}` : ""}`);
      }
      if (await accepts(local)) return local;
      await Bun.sleep(150);
    }
    proc.kill();
    throw new Error(`ssh tunnel to ${ssh.at(-1)} did not open in 15s`);
  }

  close(): void {
    for (const p of this.processes) p.kill();
    this.processes.length = 0;
    this.open.clear();
  }
}
