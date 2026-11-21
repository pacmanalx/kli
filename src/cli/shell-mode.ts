import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutMiddle, plainText } from "../core/index.ts";
import { shellQuote } from "../core/tunnels.ts";

/**
 * `!command` in the session: the person runs a command themselves, with the terminal handed over to it, so what
 * asks for a password, sudo or a login works (the model's Bash has no terminal). `script` records what appears on
 * the screen, to show it in the conversation and give it to the model with the next message.
 */

/** What the model gets of a command's screen at most. */
const MAX_NOTE = 20_000;

/** The command under `script`, which gives it a terminal and records it; none where there is no `script`. */
export function scriptArgs(command: string, file: string, platform: string = process.platform, has = (c: string) => !!Bun.which(c)): string[] | undefined {
  if (!has("script")) return undefined;
  if (platform === "darwin" || platform.endsWith("bsd")) return ["script", "-q", file, "bash", "-c", command];
  // util-linux: -e returns the command's exit code
  if (platform === "linux") return ["script", "-q", "-e", "-c", `bash -c ${shellQuote(command)}`, file];
  return undefined;
}

/** A recording as text: without the lines `script` adds, terminal codes and the ^D at the end. */
export function cleanRecording(raw: string): string {
  return plainText(raw)
    .split("\n")
    .filter((l) => !/^Script (started|done) on /.test(l))
    .join("\n")
    .replace(/\^D\x08*\s*$/, "")
    .trim();
}

export interface ShellResult {
  code: number | null;
  ms: number;
  /** What appeared on the screen; undefined when it could not be recorded. */
  output?: string;
}

/** Runs it in this terminal (the caller has given the terminal up) and waits for it to end. */
export async function runYourself(command: string, cwd: string): Promise<ShellResult> {
  const file = join(tmpdir(), `kli-shell-${process.pid}-${Date.now()}.txt`);
  const argv = scriptArgs(command, file) ?? ["bash", "-c", command];
  const started = performance.now();
  const proc = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  const ms = Math.round(performance.now() - started);
  let output: string | undefined;
  if (argv[0] === "script")
    try {
      output = cleanRecording(readFileSync(file, "utf8"));
    } catch {
      // nothing recorded
    } finally {
      rmSync(file, { force: true });
    }
  return { code: proc.signalCode ? null : code, ms, output };
}

/** What the model gets with the next message. */
export function shellNote(command: string, r: ShellResult): string {
  const shown = r.output === undefined ? "(what it printed was not recorded)" : cutMiddle(r.output, MAX_NOTE) || "(no output)";
  return `The person ran this command themselves, in the terminal, in the working directory:\n$ ${command}\n${shown}\n[exit code ${r.code ?? "none"}]`;
}
