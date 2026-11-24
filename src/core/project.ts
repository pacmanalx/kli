import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { exactOnly } from "./shell.ts";
import { PLAIN_COMMAND, writeProblems } from "./stack.ts";
import type { FenceSettings } from "./fence.ts";
import type { StackConfig } from "./types.ts";

/**
 * How a node that writes checks its work, and which commands it may run, comes from the project, not from Kli: what the project declares
 * in `.kli/write.json`, else what the stack says, else what its files show (a lockfile, go.mod, Cargo.toml…). The
 * person never has to tell Kli how their project tests. Nothing is set up: a node works in the folder or in a copy of
 * it, which has the folder's dependencies already.
 */

export interface ProjectCommands {
  /** How the nodes' commands are fenced: the project's say, else the stack's (core/fence.ts). */
  fence?: FenceSettings;
  /** Commands the nodes may run besides the ones that read: each allows the ones that start with it. */
  run: string[];
  check?: string;
  /** Where they came from, said on screen: ".kli/write.json", "the stack", "bun.lock"… */
  source?: string;
}

/** The project's own declaration, in the folder where Kli runs or at the top of its repository. */
export const PROJECT_FILE = join(".kli", "write.json");

function declared(folders: string[]): (NonNullable<StackConfig["write"]> & { file: string }) | undefined {
  for (const folder of folders) {
    const file = join(folder, PROJECT_FILE);
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${PROJECT_FILE}: ${(e as Error).message}`);
    }
    const problems = writeProblems(PROJECT_FILE, raw as StackConfig["write"]);
    if (problems.length) throw new Error(problems.join("; "));
    return { ...(raw as NonNullable<StackConfig["write"]>), file: PROJECT_FILE };
  }
}

const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "__pycache__"]);
/** Enough of a big repository to know if it has tests: the walk stops after this many entries. */
const MAX_WALK = 20_000;

/** The folder's own test files (up to `max`), from its top: not in node_modules, hidden or vendored folders. */
function testFiles(root: string, names: RegExp, max = 1): string[] {
  const found: string[] = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < MAX_WALK) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP.has(e.name)) queue.push(join(dir, e.name));
      } else if (names.test(e.name)) {
        found.push(relative(root, join(dir, e.name)));
        if (found.length >= max) return found;
      }
    }
  }
  return found;
}

/** Whether the folder has test files of its own. */
const hasTests = (root: string, names: RegExp) => testFiles(root, names).length > 0;

/** What makes a folder a Python project even with no lockfile. */
const PY_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "conftest.py", "tox.ini"];
/** Python test files: test_x.py or x_test.py. */
const PY_TESTS = /^(test_.*|.*_test)\.py$/;

/** Runtimes that run whatever they are given: alone, as a script's command, they would let any code through. */
const RUNTIMES = new Set(["node", "bun", "deno", "npx", "bunx", "pnpx", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php"]);

/**
 * A package script's own command ("bun test", "vitest run", "tsc --noEmit"), when it is one plain command: the script
 * runs it anyway, and a model that types it, or adds a file or a flag (`bun test test/a.test.ts`), is not refused
 * (23/11/2026: a 7B model asked for `bun test` four times where only `npm test` ran, and gave up). Nothing that
 * removes, runs other programs or is a runtime alone: those stay behind the script's name.
 */
function scriptCommand(body: string): string | undefined {
  const command = body.trim();
  if (!PLAIN_COMMAND.test(command)) return undefined;
  const words = command.split(" ");
  if (exactOnly(words[0]!) || (words.length === 1 && RUNTIMES.has(words[0]!))) return undefined;
  return command;
}

/** One project the files show: its commands, run from the top of the folder, and the file that showed it. */
interface Found {
  source: string;
  run: string[];
  check?: string;
}

/**
 * The project in `dir`, from its files; `at` is where it is from the top ("" at the top, else "frontend"), so its
 * check goes there first. The commands the nodes may run are the tool's own, wherever they run them.
 */
function detectIn(dir: string, at: string, which: (cmd: string) => string | null, loose = true): Found | undefined {
  const has = (f: string) => existsSync(join(dir, f));
  const here = (command: string) => (at ? `cd ${at} && ${command}` : command);
  const source = (file: string) => (at ? `${at}/${file}` : file);
  const found = (file: string, tool: string, commands: { run: string[]; check?: string }): Found =>
    which(tool)
      ? { source: source(file), run: commands.run, ...(commands.check && { check: here(commands.check) }) }
      : { source: `${source(file)}, but ${tool} is not installed`, run: [] };

  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {}
    const [lock, tool] = has("bun.lock") || has("bun.lockb")
      ? [has("bun.lock") ? "bun.lock" : "bun.lockb", "bun"]
      : has("pnpm-lock.yaml")
        ? ["pnpm-lock.yaml", "pnpm"]
        : has("yarn.lock")
          ? ["yarn.lock", "yarn"]
          : has("package-lock.json")
            ? ["package-lock.json", "npm"]
            : ["package.json", "npm"];
    const script = (name: string) => `${tool} ${tool === "npm" && name === "test" ? "test" : `run ${name}`}`;
    // npm init's test script only says there is none
    const test = scripts.test && !/no test specified/.test(scripts.test) ? script("test") : tool === "bun" && hasTests(dir, /\.(test|spec)\.[cm]?[jt]sx?$/) ? "bun test" : undefined;
    // each script, and the command it runs when that is one plain command
    const own = (name: string) => [script(name), scriptCommand(scripts[name]!)].filter((c): c is string => !!c);
    const run = [...new Set([...(test ? (scripts.test && test === script("test") ? own("test") : [test]) : []), ...["typecheck", "lint"].filter((s) => scripts[s]).flatMap(own)])];
    return found(lock, tool, { run, ...(test && { check: test }) });
  }
  if (has("go.mod")) return found("go.mod", "go", { run: ["go test", "go vet", "go build"], check: "go test ./..." });
  if (has("Cargo.toml")) return found("Cargo.toml", "cargo", { run: ["cargo test", "cargo check", "cargo build"], check: "cargo test" });
  // .NET: a solution, or else a project; named when there is more than one, as dotnet asks
  const dotnet = readdirSync(dir)
    .filter((f) => /\.(slnx?|csproj|fsproj|vbproj)$/.test(f))
    .sort((a, b) => Number(!/\.slnx?$/.test(a)) - Number(!/\.slnx?$/.test(b)) || a.localeCompare(b));
  if (dotnet.length) {
    const target = dotnet.length > 1 ? ` ${dotnet[0]}` : "";
    const tests = hasTests(dir, /test.*\.(cs|fs|vb)proj$/i);
    return found(dotnet[0]!, "dotnet", { run: ["dotnet test", "dotnet build"], check: `dotnet ${tests ? "test" : "build"}${target}` });
  }
  const pytest = hasTests(dir, PY_TESTS);
  if (has("uv.lock")) return found("uv.lock", "uv", { run: pytest ? ["uv run pytest"] : [], ...(pytest && { check: "uv run pytest" }) });
  if (has("requirements.txt"))
    return found("requirements.txt", "python3", {
      run: pytest ? [".venv/bin/python -m pytest"] : [],
      ...(pytest && { check: ".venv/bin/python -m pytest" }),
    });
  // Python tests with no lockfile: the standard library's unittest, or pytest when the project uses it and it is
  // installed. They run from the top, as the project says to: from inside the folder, a module there named like a
  // library (csv.py) would take its place
  // at the top of a folder with projects below it, tests in one of them do not make the whole folder Python
  const tests = loose || PY_MARKERS.some(has) ? testFiles(dir, PY_TESTS, 50) : [];
  if (tests.length) {
    const from = (d: string) => [at, d === "." ? "" : d].filter(Boolean).join("/") || ".";
    const usesPytest = has("conftest.py") || has("pytest.ini") || (has("pyproject.toml") && /pytest/.test(readFileSync(join(dir, "pyproject.toml"), "utf8")));
    if (usesPytest && which("pytest")) return { source: source(tests[0]!), run: ["pytest", "python3 -m pytest"], check: `python3 -m pytest ${from(".")}` };
    const dirs = [...new Set(tests.map((t) => dirname(t)))].slice(0, 4);
    return which("python3")
      ? { source: source(tests[0]!), run: ["python3 -m unittest"], check: dirs.map((d) => `python3 -m unittest discover -s ${from(d)}`).join(" && ") }
      : { source: `${source(tests[0]!)}, but python3 is not installed`, run: [] };
  }
  return undefined;
}

/**
 * What the project's files show; `which` finds a program (Bun.which, or a stand-in in the tests). Nothing at the top
 * (a backend and a frontend side by side, say): each folder just below it that is a project adds its commands.
 */
export function detectCommands(root: string, which: (cmd: string) => string | null = (c) => Bun.which(c)): ProjectCommands | undefined {
  const top = detectIn(root, "", which, false);
  let found = top
    ? [top]
    : readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name) && /^[\w@%+=:,.-]+$/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((e) => detectIn(join(root, e.name), e.name, which) ?? []);
  // no project at the top nor below it: tests anywhere still say how to check it
  if (!found.length) found = [detectIn(root, "", which)].filter((f): f is Found => !!f);
  if (!found.length) return undefined;
  // more than one: each in its own subshell, so one's cd does not move the next
  const joined = (commands: string[]) => (commands.length > 1 ? commands.map((c) => `(${c})`).join(" && ") : commands[0]);
  const check = joined(found.flatMap((f) => f.check ?? []));
  return { run: [...new Set(found.flatMap((f) => f.run))], ...(check && { check }), source: found.map((f) => f.source).join(" + ") };
}

/**
 * The commands for the nodes that write, field by field: the project's `.kli/write.json` (in the folder, or at the
 * top of the repository), else the stack's `write`, else what the files show. The allowed commands add up.
 */
export function projectCommands(folders: string[], stack: StackConfig["write"], which?: (cmd: string) => string | null): ProjectCommands {
  const own = declared(folders);
  const found = detectCommands(folders[0]!, which);
  const check = own?.check ?? stack?.check ?? found?.check;
  const run = [...new Set([...(own?.run ?? []), ...(stack?.run ?? []), ...(found?.run ?? [])].map((c) => c.trim()).filter(Boolean))];
  const sources = [own?.file, stack?.check || stack?.run?.length ? "the stack" : undefined, found?.source].filter(Boolean);
  const fence = own?.fence ?? stack?.fence;
  return { run, ...(check && { check }), ...(fence !== undefined && { fence }), ...(sources.length && { source: sources.join(" + ") }) };
}

/** Folders of a copy to look for the project's declaration in: where Kli runs, then the top of the repository. */
export const projectFolders = (root: string, top: string): string[] => (root === top ? [root] : [root, top]);
