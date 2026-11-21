import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { worktreeGitDir } from "./fence.ts";
import { cutMiddle, Job } from "./jobs.ts";

/**
 * Nodes that write, when a stack compares two or more, each work in a copy of the person's folder for one round (one
 * request): a plain copy of the folder, cloned by the file system (APFS on the Mac, reflink where Linux has it), with
 * its .git, its dependencies and the rest, so it works in or out of git and nothing is set up or registered in the
 * person's repository. What each node changed is measured with a git of Kli's own; only the one the person applies
 * goes to the folder, and then, or with no choice, every copy goes away. A stack's one node that writes works in the
 * folder itself (`Here`), measured the same way.
 */

/** What a node changed where it worked, against how it was when its answer started. */
export interface Changes {
  /** `binary`: a file with no lines to count (an image, a compiled file). */
  files: { path: string; added: number; removed: number; binary?: boolean }[];
  added: number;
  removed: number;
  /** The diff (`git diff --binary`), which `git apply` takes, from the top of the folder. */
  patch: string;
  /** Where the diff was saved, to see it, or apply it by hand. */
  patchFile?: string;
  /** Made in the person's folder itself (the stack's one node that writes): there is nothing to apply. */
  inFolder?: boolean;
}

/** A command run where a node worked (the project's check): how it ended and the end of what it printed. */
export interface CommandResult {
  command: string;
  ok: boolean;
  /** null when a signal stopped it. */
  code: number | null;
  ms: number;
  output: string;
}

const GIT = ["git", "-c", "core.quotepath=off"];

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([...GIT, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env && { env: { ...process.env, ...env } }) });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

async function gitOk(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code) throw new Error(`git ${args[0]} failed: ${r.err.trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
  return r.out;
}

/** The git repository a folder is in: its top, its own git folder, and the one it shares (a worktree's, a submodule's). */
export interface Repo {
  top: string;
  gitDir: string;
  common: string;
}

export async function repoOf(folder: string): Promise<Repo | undefined> {
  const r = await git(folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  const [top, gitDir, common] = r.out.trim().split("\n");
  return r.code || !top || !gitDir || !common ? undefined : { top: realpathSync(top), gitDir, common };
}

/**
 * What tools make and fetch is not the project's work: a new file under these is never a change (a test run leaves a
 * __pycache__ in a project that does not ignore it). A file the repository already has is measured all the same.
 */
export const NOT_THE_PROJECT = ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".gradle", ".next", "target", "obj", ".DS_Store"];

/** Out of git, a folder with more files than this is not copied nor measured: it is not a project (a home folder). */
export const MAX_LOOSE_FILES = 20_000;

/** How many files a folder out of git has, up to `limit` (what tools make, as above, not counted). */
export function looseFiles(folder: string, limit = MAX_LOOSE_FILES): number {
  let count = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count > limit) return;
      if (e.name === ".git" || NOT_THE_PROJECT.includes(e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else count++;
    }
  };
  walk(folder);
  return count;
}

/**
 * A git of Kli's own, next to the session's copies, where it takes trees of a folder (as git sees it, the ignored
 * files left out) and compares them. The person's repository is only read: its objects (so nothing is hashed twice),
 * its index (so only what changed is read again), its exclude list. Nothing is written there, and their index is
 * never touched. New files of what tools make (`NOT_THE_PROJECT`) are left out, in a repository or not.
 */
export class Snapshots {
  private constructor(
    readonly dir: string,
    /** The person's index, read to know which files changed since. */
    private readonly index?: string,
  ) {}

  static async open(dir: string, repo?: Repo): Promise<Snapshots> {
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(dir, { recursive: true });
      await gitOk(dir, ["init", "--quiet", "--bare", "."]);
      // a clone has new inodes and change times, but the same contents and modification times
      for (const [key, value] of [["core.bare", "false"], ["core.checkStat", "minimal"], ["core.trustCtime", "false"], ["gc.auto", "0"], ["core.fsmonitor", "false"]])
        await gitOk(dir, ["config", key!, value!]);
      if (repo) writeFileSync(join(dir, "objects", "info", "alternates"), join(repo.common, "objects") + "\n");
      const exclude = repo && join(repo.common, "info", "exclude");
      const theirs = exclude && existsSync(exclude) ? readFileSync(exclude, "utf8").trimEnd() + "\n" : "";
      writeFileSync(join(dir, "info", "exclude"), theirs + NOT_THE_PROJECT.map((n) => `${n}\n`).join(""));
    }
    return new Snapshots(dir, repo && join(repo.gitDir, "index"));
  }

  /** The folder `work` as git sees it now (new files included, the ignored ones not), as a tree. */
  async tree(work: string): Promise<string> {
    const index = join(this.dir, `index-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const take = async () => {
      const env = { GIT_DIR: this.dir, GIT_WORK_TREE: work, GIT_INDEX_FILE: index };
      await gitOk(work, ["add", "-A"], env);
      return (await gitOk(work, ["write-tree"], env)).trim();
    };
    try {
      if (this.index && existsSync(this.index)) {
        cpSync(this.index, index, { preserveTimestamps: true });
        // an index git cannot read here (a split one): every file is read
        try {
          return await take();
        } catch {
          rmSync(index, { force: true });
        }
      }
      return await take();
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** What changed from tree `a` to tree `b`: the files, with their lines, and the diff. */
  async diff(a: string, b: string): Promise<Changes> {
    const env = { GIT_DIR: this.dir };
    const files = (await gitOk(this.dir, ["diff", "--numstat", "-z", "--no-renames", a, b], env))
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...path] = line.split("\t");
        // a binary file has no lines to count
        return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0, ...(added === "-" && { binary: true }) };
      });
    const patch = files.length ? await gitOk(this.dir, ["diff", "--binary", "--no-renames", a, b], env) : "";
    return { files, added: files.reduce((t, f) => t + f.added, 0), removed: files.reduce((t, f) => t + f.removed, 0), patch };
  }

  /** The paths that differ from tree `a` to tree `b`. */
  async changed(a: string, b: string): Promise<string[]> {
    return (await gitOk(this.dir, ["diff", "--name-only", "-z", "--no-renames", a, b], { GIT_DIR: this.dir })).split("\0").filter(Boolean);
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * Copies a folder as the file system can do it fastest: cloned (APFS, a reflink), else for real. A file it cannot
 * read (a socket, another user's) stays out of the copy; it was never the node's to change.
 */
async function clone(from: string, to: string): Promise<void> {
  const tries = process.platform === "darwin" ? [["cp", "-c", "-R", "-p"], ["cp", "-R", "-p"]] : [["cp", "-a", "--reflink=auto"]];
  let why = "";
  for (const cp of tries) {
    const proc = Bun.spawn([...cp, from, to], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (!code || existsSync(to)) return;
    why = err.trim().split("\n").at(-1) ?? `exit ${code}`;
  }
  throw new Error(`could not copy the folder: ${why}`);
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

export class Copy {
  private constructor(
    /** The copy: the top of the folder (of its repository, when it is in one), copied. */
    readonly path: string,
    /** The folder inside the copy that stands for the one where Kli runs: the node's tools work there. */
    readonly root: string,
    /** The top of the person's folder, where an applied change goes. */
    private readonly top: string,
    private readonly snapshots: Snapshots,
    /** How the copy was when it was made: what the node changes is measured from it. */
    private readonly start: string,
  ) {}

  /** A copy of the folder at `path`, as the person has the folder now. */
  static async make(folder: string, path: string, snapshots: Snapshots, repo?: Repo): Promise<Copy> {
    const real = realpathSync(folder);
    const top = repo?.top ?? real;
    mkdirSync(dirname(path), { recursive: true });
    if (inside(join(realpathSync(dirname(path)), basename(path)), top)) throw new Error(`the copies would go inside the folder they copy (${top}): Kli's sessions folder is in it`);
    if (!repo && looseFiles(top) > MAX_LOOSE_FILES) throw new Error(`this folder is not in git and has more than ${MAX_LOOSE_FILES} files: too big to copy and compare (open Kli in the project's folder)`);
    await rm(path, { recursive: true, force: true });
    await clone(top, path);
    try {
      if (repo) await ownRepository(path, repo);
      return new Copy(path, join(path, relative(top, real)), top, snapshots, await snapshots.tree(path));
    } catch (e) {
      await rm(path, { recursive: true, force: true });
      throw e;
    }
  }

  /** What the node changed since the copy was made (new files included, ignored ones not). */
  async changes(): Promise<Changes> {
    return this.snapshots.diff(this.start, await this.snapshots.tree(this.path));
  }

  /** Saves the diff next to the copy (the copy goes away; the diff stays with the session). */
  savePatch(changes: Changes): string {
    const file = `${this.path}.patch`;
    writeFileSync(file, changes.patch);
    return file;
  }

  /**
   * Brings the files the node created, changed or deleted to the person's folder, as they are in the copy: only the
   * files (git's index and commits are the person's). If the person changed one of them in the folder since the copy
   * was made, nothing is applied, and the error says which.
   */
  async apply(changes: Changes): Promise<void> {
    const paths = changes.files.map((f) => f.path);
    const theirs = new Set(await this.snapshots.changed(this.start, await this.snapshots.tree(this.top)));
    const touched = paths.filter((p) => theirs.has(p));
    if (touched.length) throw new Error(`you changed ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""} in your folder while the nodes worked: nothing was applied`);
    const gone = paths.filter((p) => !exists(join(this.path, p)));
    // what went away first: a file can become a folder
    for (const p of gone) {
      rmSync(join(this.top, p), { force: true });
      for (let d = dirname(join(this.top, p)); d !== this.top && inside(d, this.top); d = dirname(d))
        try {
          rmdirSync(d);
        } catch {
          break;
        }
    }
    for (const p of paths.filter((p) => !gone.includes(p))) {
      const from = join(this.path, p);
      const to = join(this.top, p);
      const kind = lstatSync(from);
      // a submodule's commit is not a file to bring
      if (kind.isDirectory()) continue;
      mkdirSync(dirname(to), { recursive: true });
      if (exists(to) && (kind.isSymbolicLink() || lstatSync(to).isSymbolicLink() || lstatSync(to).isDirectory())) rmSync(to, { recursive: true, force: true });
      if (kind.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else {
        copyFileSync(from, to);
        chmodSync(to, kind.mode & 0o777);
      }
    }
  }

  /** Takes the copy away (its diff stays). */
  async remove(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * A copy of a worktree of another repository, or of a submodule, came with a .git that is only a pointer to the
 * person's repository: whatever git did in the copy would move their branches and index. It gets a repository of its
 * own instead, cloned from theirs, at the same commit and index. And the worktrees a repository lists are not the
 * copy's: they would keep it from checking out their branches.
 */
async function ownRepository(copy: string, repo: Repo): Promise<void> {
  const dotGit = join(copy, ".git");
  if (lstatSync(dotGit, { throwIfNoEntry: false })?.isFile()) {
    rmSync(dotGit);
    await clone(repo.common, dotGit);
    for (const f of ["HEAD", "index"]) if (existsSync(join(repo.gitDir, f))) cpSync(join(repo.gitDir, f), join(dotGit, f), { preserveTimestamps: true });
    // a submodule's git says where its files are: here, now
    const config = join(dotGit, "config");
    if (existsSync(config)) writeFileSync(config, readFileSync(config, "utf8").replace(/^\s*worktree\s*=.*\n/m, ""));
  }
  rmSync(join(dotGit, "worktrees"), { recursive: true, force: true });
}

/**
 * The person's own folder, for a stack's one node that writes: with nothing to compare it with, it edits there, as in
 * a conversation. What it changed is measured against how the folder was when its answer started, in Kli's own git,
 * so the person's index and repository are never written. Out of git, the folder is measured too, unless it is too
 * big to be a project.
 */
export class Here {
  /** How the folder was when the node's answer started. */
  private start?: string;

  private constructor(
    /** The folder where Kli runs: the node's tools work there. */
    readonly root: string,
    /** The top of its repository, when it is in one. */
    readonly top: string | undefined,
    /** Where its diffs are saved (`<path>.patch`), next to the trace. */
    readonly path: string,
    private readonly snapshots: Snapshots | undefined,
  ) {}

  static at(folder: string, path: string, snapshots: Snapshots, repo?: Repo): Here {
    const real = realpathSync(folder);
    const measured = repo || looseFiles(real) <= MAX_LOOSE_FILES;
    return new Here(real, repo?.top, path, measured ? snapshots : undefined);
  }

  /** Before each answer: what it changes from here on is its own. */
  async mark(): Promise<void> {
    if (this.snapshots) this.start = await this.snapshots.tree(this.top ?? this.root);
  }

  /** What the node changed in the folder since its answer started. */
  async changes(): Promise<Changes | undefined> {
    if (!this.snapshots || !this.start) return undefined;
    return { ...(await this.snapshots.diff(this.start, await this.snapshots.tree(this.top ?? this.root))), inFolder: true };
  }

  savePatch(changes: Changes): string {
    const file = `${this.path}.patch`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, changes.patch);
    return file;
  }

  /** What git keeps of the folder when it is a worktree of another repository: the node's own git commands write there. */
  get gitDir(): string | undefined {
    return this.top ? worktreeGitDir(this.top) : undefined;
  }

  /** The folder is the person's: nothing to take away. */
  async remove(): Promise<void> {}
}

/** The mark of the Kli that has a session's copies: its process. */
const OWNER = ".owner";
/** A session's copies with no mark (made before the mark existed) are left alone while its trace is this recent. */
const UNMARKED_MS = 24 * 3600_000;

/** Marks a session's copies as this Kli's: when it dies without closing, the next one takes them away. */
export function claimCopies(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OWNER), String(process.pid));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // it exists, as another user's
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The copies a Kli left when it ended without closing (killed, or the machine went down), in the sessions folder:
 * taken away, with Kli's own git. Their diffs stay. A copy an older Kli made as a git worktree also leaves its
 * repository's list of worktrees. Returns what it took.
 */
export async function removeLeftovers(sessionsDir: string, except: string): Promise<string[]> {
  const removed: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(sessionsDir).filter((d) => d.endsWith(".copies") && join(sessionsDir, d) !== except);
  } catch {
    return removed;
  }
  for (const d of dirs) {
    const dir = join(sessionsDir, d);
    const pid = existsSync(join(dir, OWNER)) ? Number(readFileSync(join(dir, OWNER), "utf8")) : undefined;
    if (pid ? alive(pid) : Date.now() - mtime(join(sessionsDir, d.replace(/\.copies$/, ".jsonl"))) < UNMARKED_MS) continue;
    for (const node of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, node.name);
      if (!node.isDirectory()) continue;
      // the repository an old copy is a worktree of: gitdir is <repo>/.git/worktrees/<name>
      const gitDir = worktreeGitDir(path);
      const common = gitDir && dirname(dirname(gitDir));
      if (common && existsSync(common)) await git(dirname(common), ["--git-dir", common, "worktree", "remove", "--force", path]);
      await rm(path, { recursive: true, force: true });
      if (common && existsSync(common)) await git(dirname(common), ["--git-dir", common, "worktree", "prune"]);
      removed.push(path);
    }
  }
  return removed;
}

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Runs one of the project's commands where a node worked (in its fence, if it has one), stopped by `signal` or after `timeoutMs`. */
export async function runIn(root: string, command: string, signal?: AbortSignal, fence?: { wrap(argv: string[]): string[] }, timeoutMs = 600_000): Promise<CommandResult> {
  const started = performance.now();
  const job = new Job(command, root, fence);
  const stop = () => void job.stop();
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop);
  await job.done;
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  const code = job.code ?? null;
  return { command, ok: code === 0, code, ms: Math.round(performance.now() - started), output: cutMiddle(job.output().trimEnd(), 4000) };
}
