import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/core/discover.ts";
import { HarnessProvider, harnessArgs } from "../src/core/providers/harness.ts";
import type { Provider } from "../src/core/providers/provider.ts";
import { Router } from "../src/core/router.ts";
import { sshCommand, sshWhy, Tunnels } from "../src/core/tunnels.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-remote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
// stands in for ssh: drops the options and the destination, then runs the remote command here, in a home of its own
const fakeSsh = script(
  "ssh",
  `while [ $# -gt 0 ]; do case "$1" in -o|-J|-L) shift 2;; -N) shift;; *) shift; break;; esac; done\nmkdir -p "${dir}/home"\nHOME="${dir}/home" exec sh -c "$*"`,
);
const fake = join(import.meta.dir, "fixtures", "fake-harness.ts");

test("the ssh command: keys only, the jump, the extra options, then the destination", () => {
  expect(sshCommand({ type: "machine", ssh: "admin@192.168.10.230", jump: "aron", sshOptions: ["-o", "X=1"], providers: {} })).toEqual([
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-J", "aron", "-o", "X=1", "admin@192.168.10.230",
  ]);
});

test("a machine whose key ssh does not know yet: the failure says how to accept it, once, by hand", async () => {
  const gibbor = { type: "machine" as const, ssh: "admin@192.168.10.230", jump: "aron", providers: {} };
  const hint = "the key of admin@192.168.10.230 is not in ~/.ssh/known_hosts yet, and Kli's ssh never asks. Accept it once by hand, checking the fingerprint: ssh -J aron admin@192.168.10.230 true (in a Kli session, start it with !)";
  expect(sshWhy(sshCommand(gibbor), "Host key verification failed.\n")).toBe(hint);
  const changed = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key for 192.168.10.230 has changed and you have requested strict checking.\nHost key verification failed.\n";
  expect(sshWhy(sshCommand(gibbor), changed)).toStartWith("the key of 192.168.10.230 is not the one in ~/.ssh/known_hosts. If that machine was reinstalled, remove the old key (ssh-keygen -R 192.168.10.230)");
  expect(sshWhy(sshCommand(gibbor), "ssh: connect to host 192.168.10.230 port 22: Operation timed out\n")).toBe("ssh: connect to host 192.168.10.230 port 22: Operation timed out");
  // what the tunnel and the search of the machine say
  process.env.KLI_SSH = script("ssh-unknown", 'echo "Host key verification failed." >&2; exit 255');
  try {
    await expect(new Tunnels().port(gibbor, 11435)).rejects.toThrow(`ssh tunnel to admin@192.168.10.230 failed: ${hint}`);
    await expect(discover({ ...gibbor, providers: {} })).rejects.toThrow(`ssh to admin@192.168.10.230 failed: ${hint}`);
  } finally {
    delete process.env.KLI_SSH;
  }
});

test("a tunnel whose ssh ended (the Mac slept, the network fell) opens again, and the provider follows its port", async () => {
  // stands in for ssh -N -L: writes down its pid, then listens on the local port
  const pids = join(dir, "tunnel-pids");
  const forward = join(dir, "fake-tunnel.ts");
  writeFileSync(
    forward,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
const spec = process.argv[process.argv.indexOf("-L") + 1]!;
Bun.listen({ hostname: "127.0.0.1", port: Number(spec.split(":")[1]), socket: { data() {} } });`,
  );
  process.env.KLI_SSH = script("ssh-tunnel", `exec "${process.execPath}" "${forward}" "$@"`);
  const urls: string[] = [];
  const config = { locations: { box: { type: "machine" as const, ssh: "user@box", providers: { ollama: { type: "server" as const, port: 11434, tunnel: true } } } } };
  const router = new Router(config, (name, cfg): Provider => {
    urls.push("url" in cfg ? cfg.url! : "");
    return { name, model: cfg.model, chat: async () => ({ text: "ok" }) };
  });
  const target = router.target("box/ollama/m");
  try {
    const first = await router.connect(target);
    expect(await router.connect(target)).toBe(first); // alive: the same tunnel and the same provider
    process.kill(Number(readFileSync(pids, "utf8").trim().split("\n").at(-1)));
    let again = first;
    for (let i = 0; i < 30 && again === first; i++) {
      await Bun.sleep(100);
      again = await router.connect(target);
    }
    expect(again).not.toBe(first);
    expect(readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(2);
    expect(urls).toHaveLength(2);
    expect(urls[1]).not.toBe(urls[0]);
    expect(await Bun.connect({ hostname: "127.0.0.1", port: Number(new URL(urls[1]!).port), socket: { data() {} } }).then((s) => (s.end(), true))).toBe(true);
  } finally {
    router.tunnels.close();
    delete process.env.KLI_SSH;
  }
});

test("with no model, the {model} argument and its flag are left out", () => {
  expect(harnessArgs(["-p", "{prompt}", "--model", "{model}"], "oi", "")).toEqual(["-p", "oi"]);
  expect(harnessArgs(["-p", "{prompt}", "--model", "{model}"], "it's", "sonnet")).toEqual(["-p", "it's", "--model", "sonnet"]);
});

test("a CLI on another machine runs over ssh, the prompt quoted for the shell there", async () => {
  process.env.KLI_SSH = fakeSsh;
  try {
    const p = new HarnessProvider("box/claude", {
      type: "harness",
      command: process.execPath,
      model: "m",
      args: [fake, "claude-whole", "{prompt}"],
      format: "claude",
      ssh: sshCommand({ type: "machine", ssh: "user@box", providers: {} }),
    });
    const r = await p.chat({ messages: [{ role: "user", content: `it's "quoted" $HOME` }] });
    expect(r.text).toBe(`got ${`it's "quoted" $HOME`.length} chars`);
  } finally {
    delete process.env.KLI_SSH;
  }
});

test("finding what another machine has: its CLIs, and its localhost ports through a tunnel", async () => {
  process.env.KLI_SSH = script("ssh-discover", 'printf "cli claude\\ncli kimi\\nport 11434\\nport 9\\n"');
  try {
    expect(await discover({ type: "machine", ssh: "user@box", providers: {} })).toEqual({
      claude: { type: "cli", command: "claude" },
      kimi: { type: "cli", command: "kimi" },
      ollama: { type: "server", port: 11434, tunnel: true },
    });
  } finally {
    delete process.env.KLI_SSH;
  }
});
