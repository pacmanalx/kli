import type { Subprocess } from "bun";

/**
 * A command running in bash, in a process group of its own, so stopping it stops what it started too (npm run dev
 * starts node, which starts more). stdout and stderr come together, in the order they were written, as in a
 * terminal. It runs in the foreground of a tool call, or in the background with an id (b1, b2…).
 */

/** More output than this is dropped from the front: a dev server can print for hours. */
const MAX_KEPT = 2_000_000;
/** After the command exits, how long to wait for what it left running (a daemon holding the output) to let go. */
const DRAIN_MS = 500;

/** Jobs still running, stopped if Kli exits without closing its workspace. */
const live = new Set<Job>();
process.on("exit", () => {
  for (const job of live) job.kill("SIGKILL");
});

export class Job {
  /** b1, b2…: given when it goes to the background. */
  id = "";
  readonly started = Date.now();
  /** Exit code once it ended (null when a signal stopped it). */
  code?: number | null;
  ended?: number;
  /** The model was told how it ended (BashOutput, or a note in the next prompt). */
  told = false;
  readonly done: Promise<void>;
  private text = "";
  private dropped = 0;
  /** Up to where BashOutput has shown the output. */
  private shown = 0;
  private readonly listeners = new Set<(chunk: string) => void>();
  private readonly proc: Subprocess<"ignore", "pipe", "ignore">;
  private stopped = false;

  constructor(
    readonly command: string,
    cwd: string,
    /** A box to run it in (a node that writes runs its commands in a fence: core/fence.ts). */
    fence?: { wrap(argv: string[]): string[] },
  ) {
    // bash's stderr goes where its stdout goes, for the whole command
    const argv = ["bash", "-c", `exec 2>&1\n${command}`];
    this.proc = Bun.spawn(fence ? fence.wrap(argv) : argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
    live.add(this);
    this.done = this.collect();
  }

  private async collect(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stdout.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        this.add(decoder.decode(value, { stream: true }));
      }
    })().catch(() => {});
    const code = await this.proc.exited;
    this.code = this.proc.signalCode ? null : code;
    await Promise.race([pump, Bun.sleep(DRAIN_MS)]);
    await reader.cancel().catch(() => {});
    this.add(decoder.decode());
    this.ended = Date.now();
    live.delete(this);
  }

  private add(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    if (this.text.length > MAX_KEPT) {
      const cut = this.text.length - MAX_KEPT;
      this.text = this.text.slice(cut);
      this.dropped += cut;
    }
    for (const listen of this.listeners) listen(chunk);
  }

  /** Each piece of output as it comes; returns how to stop listening. */
  listen(fn: (chunk: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get running(): boolean {
    return this.ended === undefined;
  }

  /** Everything it printed (what is still kept), for people and models: no colors, progress bars at their last state. */
  output(): string {
    return plainText(this.text);
  }

  /** What it printed since the last call: what BashOutput gives. */
  unread(): string {
    const from = Math.max(0, this.shown - this.dropped);
    const lost = this.shown < this.dropped ? `… (${this.dropped - this.shown} characters were dropped)\n` : "";
    this.shown = this.dropped + this.text.length;
    return lost + plainText(this.text.slice(from));
  }

  /** From now on, unread() starts here (what was already shown another way). */
  markRead(): void {
    this.shown = this.dropped + this.text.length;
  }

  /** "running for 1m 12s", "exited with code 0 after 4.2s", "stopped after 3s". */
  status(now = Date.now()): string {
    if (this.running) return `running for ${duration(now - this.started)}`;
    const took = duration(this.ended! - this.started);
    return this.code === null || this.stopped ? `stopped after ${took}` : `exited with code ${this.code} after ${took}`;
  }

  /** Stops it and what it started: TERM, then KILL if it is still there after 2 s. */
  stop(): Promise<void> {
    if (!this.running) return this.done;
    this.stopped = true;
    this.kill("SIGTERM");
    const force = setTimeout(() => this.kill("SIGKILL"), 2000);
    return this.done.finally(() => clearTimeout(force));
  }

  kill(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.proc.pid, signal);
    } catch {
      // already gone
    }
  }
}

/** 4.2s, 1m 12s, 2h 5m. */
export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Terminal output as text: colors and cursor moves taken off, a line rewritten with \r (a progress bar) kept at
 * its last state, other control characters dropped.
 */
export function plainText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const pieces = line.split("\r").filter(Boolean);
      let text = pieces.at(-1) ?? "";
      // a backspace takes the character before it
      while (/[^\x08]\x08/.test(text)) text = text.replace(/[^\x08]\x08/g, "");
      return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    })
    .join("\n");
}

/** Long output keeps its start and its end (where the errors usually are). */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n… (${text.length - 2 * half} characters cut) …\n${tail}`;
}
