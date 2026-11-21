import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A box around the commands of a node that writes (the ones it runs, and the project's check in its copy): they write
 * only in its copy, in the temporary folders and in the tools' caches; they do not read the person's keys; and they
 * reach no network but this machine's, unless the project says so. The system's own box does it: `sandbox-exec` on
 * macOS, `bwrap` on Linux. It stops what is common and does harm (erasing or changing the person's files, reading a
 * key and sending it away); a cache can still be written, so it is a fence, not a vault.
 */

/** Set inside a fence: a Kli run there (a stack working on Kli itself) does not box again, as macOS's box cannot. */
const INSIDE = "KLI_FENCE";

/** How the project or the stack sets the fence: `false` turns it off. */
export type FenceSettings = false | { network?: boolean; write?: string[] };

/** What a fenced command may write besides its copy: the caches the tools write even when they only build or test. */
const CACHES = [".cache", "Library/Caches", ".npm/_cacache", ".npm/_logs", ".cargo/registry", ".cargo/git", ".nuget/packages", ".local/share/NuGet", ".gradle/caches", ".m2/repository"];
/** Files the tools write in folders that hold more than caches: a lock (cargo), first-use marks and caches (dotnet). */
const CACHE_FILES = [/^\.cargo\/\.package-cache/, /^\.dotnet\/[^/]*(Sentinel|sentinel|UserLevelCache)$/, /^\.dotnet\/TelemetryStorageService\//];
/** What no fenced command reads: keys and logins. */
const HIDDEN = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config/gcloud", ".docker/config.json", ".netrc", ".git-credentials", ".kli/.env"];

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A path for the profile: in quotes, with what would end them escaped. */
const quoted = (path: string) => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const regex = (re: RegExp, home: string) => `#"^${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${re.source.replace(/^\^/, "")}"`;

/** Why bwrap cannot make its box on this system, tried once: installed, but a container or the system may not allow user namespaces. */
let bwrapWhy: string | undefined | null = null;
function bwrapFails(): string | undefined {
  if (bwrapWhy !== null) return bwrapWhy;
  const r = Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "true"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  bwrapWhy = r.exitCode === 0 ? undefined : r.stderr.toString().trim().replace(/^bwrap: /, "") || `it ended with ${r.exitCode}`;
  return bwrapWhy;
}

export class Fence {
  private constructor(
    /** The system's box: "sandbox-exec" or "bwrap". */
    readonly tool: "sandbox-exec" | "bwrap",
    private readonly writable: string[],
    readonly network: boolean,
    private readonly home: string,
  ) {}

  /**
   * The fence for a copy, or why there is none: turned off, or a system without a box (Linux without bwrap, or with a
   * bwrap the system does not let make one). `write` are the copy and what git keeps of it; the settings add folders
   * and the network.
   */
  static for(
    write: string[],
    settings?: FenceSettings,
    system: { platform: string; which: (c: string) => string | null; home: string; inside?: boolean; fails?: (tool: string) => string | undefined } = {
      platform: process.platform,
      which: (c) => Bun.which(c),
      home: homedir(),
      inside: !!process.env[INSIDE],
      fails: (tool) => (tool === "bwrap" ? bwrapFails() : undefined),
    },
  ): Fence | { none: string } {
    if (settings === false) return { none: "the project turned the fence off" };
    if (system.inside) return { none: "Kli itself runs inside a fence, which still holds" };
    const tool = system.platform === "darwin" ? "sandbox-exec" : system.platform === "linux" ? "bwrap" : undefined;
    if (!tool) return { none: `no fence on ${system.platform}` };
    if (!system.which(tool)) return { none: `${tool} is not installed` };
    const why = system.fails?.(tool);
    if (why) return { none: `${tool} cannot make its box here: ${why}` };
    const home = real(system.home);
    const temp = real(tmpdir());
    const extra = (settings?.write ?? []).map((p) => real(p.replace(/^~(?=\/|$)/, home)));
    // on macOS the temporary folder's parent also has the per-user cache (T and C), and /tmp is /private/tmp
    const temps = system.platform === "darwin" ? [dirname(temp), "/private/tmp"] : [temp, "/tmp", "/var/tmp"];
    const writable = [...new Set([...write.map(real), ...temps, ...extra])];
    return new Fence(tool, writable, !!settings?.network, home);
  }

  /** The command line that runs `argv` inside the fence. */
  wrap(argv: string[]): string[] {
    if (this.tool === "bwrap") return this.bwrap(argv);
    // macOS's box knows localhost as 127.0.0.1 and ::1, not as ::ffff:127.0.0.1, which .NET's sockets use: without
    // IPv6, dotnet test reaches its own test host
    return ["sandbox-exec", "-p", this.profile(), "env", `${INSIDE}=1`, ...(this.network ? [] : ["DOTNET_SYSTEM_NET_DISABLEIPV6=1"]), ...argv];
  }

  /** In a few words, for the screen: "writes only in its copy, no network". */
  describe(where = "its copy"): string {
    return `${this.tool}: writes only in ${where}${this.network ? "" : ", no network"}`;
  }

  /** macOS: everything is allowed but writing (only in the places above), reading the keys, and the network. */
  private profile(): string {
    const home = this.home;
    const rules = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* ${[...this.writable, ...CACHES.map((c) => join(home, c))].map((p) => `(subpath ${quoted(p)})`).join(" ")})`,
      `(allow file-write* ${CACHE_FILES.map((re) => `(regex ${regex(re, home)})`).join(" ")})`,
      '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
      `(deny file-read* file-write* ${HIDDEN.map((h) => `(subpath ${quoted(join(home, h))})`).join(" ")})`,
    ];
    // this machine only: its own sockets, and listening and connecting on localhost (a test's server); "local ip"
    // on an outgoing connection would let everything through
    if (!this.network)
      rules.push(
        "(deny network*)",
        "(allow network* (remote unix-socket))",
        '(allow network-bind (local ip "localhost:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
      );
    return rules.join("\n");
  }

  /** Linux: the whole system read-only, the places above writable, the keys hidden, and a network of its own. */
  private bwrap(argv: string[]): string[] {
    const home = this.home;
    // a folder is covered by an empty one, a file by /dev/null
    const hide = HIDDEN.map((h) => join(home, h)).flatMap((p) => {
      try {
        return statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p];
      } catch {
        return [];
      }
    });
    const caches = [...CACHES, ".cargo/.package-cache", ".cargo/.package-cache-mutate"].map((c) => join(home, c));
    return [
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      ...[...this.writable, ...caches].flatMap((p) => ["--bind-try", p, p]),
      ...hide,
      ...(this.network ? [] : ["--unshare-net"]),
      "--setenv", INSIDE, "1",
      "--die-with-parent",
      "--",
      ...argv,
    ];
  }
}

/** What git keeps of a worktree outside it (its index, its HEAD): `gitdir:` in its .git file. */
export function worktreeGitDir(copy: string): string | undefined {
  try {
    const dir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(copy, ".git"), "utf8"))?.[1]?.trim();
    return dir ? real(dir) : undefined;
  } catch {
    return undefined;
  }
}
