/**
 * The release binaries, what a GitHub release carries: macOS and Linux, arm64 and x64, in dist/release, with their
 * SHA-256 sums. `bun build --compile` reaches every target from one machine; on macOS the darwin ones come out signed
 * (ad hoc), which Apple silicon needs to run them, so the release is built on a Mac.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const root = join(import.meta.dir, "..");
const out = join(root, "dist", "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const sums: string[] = [];
for (const target of TARGETS) {
  const name = `kli-${target}`;
  const build = Bun.spawnSync(
    [process.execPath, "build", "src/cli/main.ts", "--compile", `--target=bun-${target}`, "--define", 'process.env.NODE_ENV="production"', "--outfile", join(out, name)],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  sums.push(`${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`);
}
writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(sums.join("\n"));
