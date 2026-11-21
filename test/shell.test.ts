import { expect, test } from "bun:test";
import { covers, describeRules, parseCommand, readsOnly, ruleFor, writesOutside, type CommandPart } from "../src/core/shell.ts";

const parts = (command: string): CommandPart[] => {
  const p = parseCommand(command);
  if ("opaque" in p) throw new Error(`opaque: ${p.opaque}`);
  return p.parts;
};
const words = (command: string) => parts(command).map((p) => p.words.join(" "));
const rule = (command: string) => {
  const r = ruleFor(parts(command)[0]!);
  return r && `${r.words.join(" ")}${r.exact ? " (exactly)" : ""}`;
};

test("a line is split into its parts, with the quotes taken off and the redirections apart", () => {
  expect(words(`cd web && npm run build; npm test | tee out.log & echo "a  b" 'c;d' \\; x`)).toEqual(["cd web", "npm run build", "npm test", "tee out.log", "echo a  b c;d ; x"]);
  expect(words("a || b\nc |& d")).toEqual(["a", "b", "c", "d"]);
  const [build] = parts("npm run build > build.log 2>&1");
  expect(build).toMatchObject({ words: ["npm", "run", "build"], writes: ["build.log"] });
  expect(parts("make 2>/dev/null >>out.txt &> all.log")[0]!.writes).toEqual(["out.txt", "all.log"]);
  expect(parts("grep x <<< 'text' < in.txt # a comment > nothing")[0]).toMatchObject({ words: ["grep", "x"], writes: [] });
  expect(parts('echo $HOME "${X}" \'$Y\'')[0]!.dynamic).toEqual([false, true, true, false]);
});

test("what can hide another command is opaque: always asked", () => {
  for (const c of ["echo $(rm -rf ~)", "echo `id`", "diff <(ls a) <(ls b)", "(cd x && rm y)", "cat <<EOF\nx\nEOF", "for f in *; do rm $f; done", "if true; then x; fi", "echo 'open"])
    expect("opaque" in parseCommand(c)).toBe(true);
});

test("the rule: the command and its subcommands; exactly as asked when one word would allow too much", () => {
  expect(rule("npm run build -- --prod")).toBe("npm run build");
  expect(rule("git push --force origin main")).toBe("git push");
  expect(rule("gcloud run deploy api --region us-central1")).toBe("gcloud run deploy");
  expect(rule("python3 scripts/deploy.py --env prod")).toBe("python3 scripts/deploy.py");
  expect(rule("npm --version")).toBe("npm --version (exactly)");
  expect(rule("python3 -c 'import os'")).toBe("python3 -c import os (exactly)");
  expect(rule("make")).toBe("make (exactly)");
  expect(rule("rm -rf dist")).toBe("rm -rf dist (exactly)");
  expect(rule("ssh aron 'systemctl restart app'")).toBe("ssh aron systemctl restart app (exactly)");
  expect(rule("NODE_ENV=production npm run build")).toBe("NODE_ENV=production npm run build (exactly)");
  expect(rule("cat ../../etc/passwd")).toBe("cat ../../etc/passwd (exactly)");
  expect(rule("rm -rf $DIR")).toBeUndefined();
  expect(rule("$CMD build")).toBeUndefined();
});

test("a rule covers the commands that start with it, never a different subcommand", () => {
  const build = ruleFor(parts("npm run build")[0]!)!;
  expect(covers(build, parts("npm run build --watch")[0]!)).toBe(true);
  expect(covers(build, parts("npm publish")[0]!)).toBe(false);
  expect(covers(build, parts("npm run build:prod")[0]!)).toBe(false);
  expect(covers(build, parts("npm run $X")[0]!)).toBe(false);
  const rm = ruleFor(parts("rm -rf dist")[0]!)!;
  expect(covers(rm, parts("rm -rf dist")[0]!)).toBe(true);
  expect(covers(rm, parts("rm -rf dist ~")[0]!)).toBe(false);
  expect(describeRules([build, rm])).toBe("npm run build commands and rm -rf dist (exactly)");
});

test("redirections that write outside the folder are found", () => {
  const [p] = parts("echo x > ~/.zshrc 2>&1 >> notes.txt > /tmp/a > $OUT");
  expect(writesOutside(p!, "/work/project")).toEqual(["~/.zshrc", "/tmp/a", "$OUT"]);
});

test("commands that only read inside the folder: as in Claude Code, they need no permission", () => {
  const root = "/work/project";
  const reads = (command: string) => parts(command).every((p) => readsOnly(p, root));
  for (const c of ["ls -la", "ls src", "pwd", "cat README.md | head -20", "git status", "git --no-pager log --oneline -5", "git diff HEAD~1 -- src", "git branch -a", "find . -name '*.ts'", "grep -rn TODO src", "wc -l src/*.ts", "cd src && ls", "echo /etc/passwd", "du -sh .", "tree -L 2", "rg vendas"])
    expect([c, reads(c)]).toEqual([c, true]);
  for (const c of [
    "ls ~",
    "cat /etc/passwd",
    "cat ../../secret",
    "cd .. && ls",
    "cd",
    "ls > files.txt",
    "cat < /etc/hosts",
    "find . -delete",
    "find . -exec rm {} ;",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "rg --pre ./run.sh x",
    "git push",
    "git branch novo",
    "git -c alias.x=!rm x",
    "git diff --output=x.patch",
    "cat $FILE",
    "npm run build",
    "sed -i s/a/b/ x",
    "date 1030120026",
    "ls && rm x",
  ])
    expect([c, reads(c)]).toEqual([c, false]);
});
