import { isAbsolute, relative, resolve } from "node:path";

/**
 * Enough of the shell's grammar to know what a command line runs: its parts (split at &&, ||, ;, |, & and line
 * breaks), each one as words, and the files its redirections write to. What can hide another command ($(…),
 * `…`, <(…), subshells, here-documents, loops) makes the line opaque: it is always asked about.
 */
export interface CommandPart {
  /** The words with the quotes taken off; leading NAME=value assignments included. */
  words: string[];
  /** Which words came from a variable ($HOME, ${X}): their value is only known when it runs. */
  dynamic: boolean[];
  /** Files written by > or >> (not /dev/null, not &2). */
  writes: string[];
  /** Files read by <. */
  reads: string[];
}

export type ParsedCommand = { parts: CommandPart[] } | { opaque: string };

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "!", "[[", "]]", "{", "}", "coproc"]);

export function parseCommand(command: string): ParsedCommand {
  const parts: CommandPart[] = [];
  let part: CommandPart = { words: [], dynamic: [], writes: [], reads: [] };
  let word = "";
  let inWord = false;
  let dynamic = false;
  /** The next word is where a redirection goes: a file written or read, text (<<<), or after >& a descriptor (or a file). */
  let redirect: "write" | "read" | "text" | "dup" | undefined;
  const endWord = () => {
    if (!inWord) return;
    if (redirect === "write" || (redirect === "dup" && !/^(\d+|-)$/.test(word))) {
      if (!/^\/dev\/(null|stdout|stderr|tty)$/.test(word)) part.writes.push(word);
    } else if (redirect === "read") {
      if (!/^(\d+|-)$/.test(word)) part.reads.push(word);
    } else if (!redirect) {
      part.words.push(word);
      part.dynamic.push(dynamic);
    }
    redirect = undefined;
    word = "";
    inWord = false;
    dynamic = false;
  };
  const endPart = () => {
    endWord();
    if (part.words.length || part.writes.length) parts.push(part);
    part = { words: [], dynamic: [], writes: [], reads: [] };
  };
  const s = command;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === "\\") {
      if (next === "\n") {
        i++;
        continue;
      }
      word += next ?? "";
      inWord = true;
      i++;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return { opaque: "an unclosed quote" };
      word += s.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1]!)) {
          if (s[j + 1] !== "\n") word += s[j + 1];
          j++;
        } else if (s[j] === "`" || (s[j] === "$" && s[j + 1] === "(")) return { opaque: "a command inside another ($(…) or `…`)" };
        else {
          if (s[j] === "$" && /[\w{@*#?$!-]/.test(s[j + 1] ?? "")) dynamic = true;
          word += s[j];
        }
      }
      if (j >= s.length) return { opaque: "an unclosed quote" };
      inWord = true;
      i = j;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) return { opaque: "a command inside another ($(…) or `…`)" };
    if ((c === "<" || c === ">") && next === "(") return { opaque: "a process substitution (<(…))" };
    if (c === "(" || c === ")") return { opaque: "a subshell or function ( … )" };
    if (c === "#" && !inWord) {
      while (i < s.length && s[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === ";") {
      endPart();
      continue;
    }
    if (c === "&" && next === "&") {
      endPart();
      i++;
      continue;
    }
    if (c === "|") {
      endPart();
      if (next === "|" || next === "&") i++;
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      redirect = "write";
      i += s[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endPart();
      continue;
    }
    if (c === ">" || c === "<") {
      // a file descriptor written just before (2>, 1>>) is part of the redirection, not a word
      if (inWord && /^\d+$/.test(word) && !dynamic) {
        word = "";
        inWord = false;
      } else endWord();
      if (c === "<" && next === "<") {
        if (s[i + 2] === "<") {
          redirect = "text";
          i += 2;
          continue;
        }
        return { opaque: "a here-document (<<)" };
      }
      redirect = c === ">" ? "write" : "read";
      if (c === ">" && (next === ">" || next === "|")) i++;
      else if (next === "&") {
        // >&2, <&0: a descriptor (but >&file writes the file)
        redirect = c === ">" ? "dup" : "read";
        i++;
      } else if (c === "<" && next === ">") {
        redirect = "write";
        i++;
      }
      continue;
    }
    if (c === "$" && /[\w{@*#?$!-]/.test(next ?? "")) dynamic = true;
    word += c;
    inWord = true;
  }
  endPart();
  for (const p of parts) if (p.words.length && KEYWORDS.has(p.words[0]!)) return { opaque: `shell syntax (${p.words[0]})` };
  return { parts };
}

/** What a "don't ask again" covers: every command starting with these words, or exactly this one. */
export interface CommandRule {
  words: string[];
  exact: boolean;
}

/** Commands whose arguments are the whole danger (rm, sudo…) or that run other code (bash -c, xargs): exactly as asked. */
const EXACT = new Set([
  ..."rm rmdir mv cp dd ln chmod chown chgrp truncate shred mkfs fdisk diskutil sudo su doas kill pkill killall shutdown reboot halt".split(" "),
  ..."eval exec source . xargs env nohup nice timeout watch command builtin time find sh bash zsh fish dash ssh scp sftp osascript".split(" "),
]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** A first word a rule allows only exactly: a program that removes, runs others or leaves the machine, or a NAME=value. */
export const exactOnly = (word: string): boolean => EXACT.has(word) || ASSIGNMENT.test(word);

/** A word that names a subcommand or a file of the project: no flags, no ~, no absolute path, no ".." */
const PLAIN = /^(?!.*\.\.)[\w@+.][\w.:@+\/-]*$/;
const MAX_PREFIX = 3;

/** The rule a "don't ask again" would add for this part; none when it cannot be told apart from others. */
export function ruleFor(part: CommandPart): CommandRule | undefined {
  const { words, dynamic } = part;
  if (!words.length || dynamic[0]) return undefined;
  const exactly = (): CommandRule | undefined => (dynamic.some(Boolean) ? undefined : { words, exact: true });
  if (ASSIGNMENT.test(words[0]!) || EXACT.has(words[0]!)) return exactly();
  let n = 1;
  while (n < Math.min(words.length, MAX_PREFIX) && !dynamic[n] && PLAIN.test(words[n]!)) n++;
  // a single word would allow too much: "npm --version" would let "npm publish" through, "python3 -c …" any code
  if (n === 1) return exactly();
  return { words: words.slice(0, n), exact: false };
}

/** Whether a rule lets this part run. */
export function covers(rule: CommandRule, part: CommandPart): boolean {
  if (rule.exact) return rule.words.length === part.words.length && rule.words.every((w, i) => w === part.words[i] && !part.dynamic[i]);
  return rule.words.every((w, i) => w === part.words[i] && !part.dynamic[i]);
}

/** Whether a path is outside the working folder (or can't be known: it has a variable). */
function outside(path: string, root: string): boolean {
  if (path.includes("$")) return true;
  const rel = relative(root, resolve(root, path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
  return rel.startsWith("..") || isAbsolute(rel);
}

/** Files a part writes outside the working folder: those always ask. */
export function writesOutside(part: CommandPart, root: string): string[] {
  return part.writes.filter((w) => outside(w, root));
}

/**
 * Commands that only read, which run without asking (as in Claude Code) when what they read is inside the working
 * folder. Each one is here because none of its options writes or runs something, or because those options are
 * checked below (UNSAFE).
 */
const READERS = new Set(
  "ls pwd cat head tail wc stat file tree du df which whereis type echo printf whoami id hostname uname date uptime basename dirname realpath readlink sort uniq cut nl diff cmp comm grep egrep fgrep rg jq md5 md5sum shasum sha1sum sha256sum strings od hexdump ps true false test [ sleep cd column tr find".split(" "),
);
/** Options that make one of them write, delete or run another command. */
const UNSAFE: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  rg: /^--pre/,
  file: /^-C$/,
  date: /^(-s|--set)/,
};
/** They do not read files: what they are given is text, not a path. */
const NO_PATHS = new Set("echo printf which whereis type basename dirname sleep true false uname whoami id hostname date ps uptime pwd tr".split(" "));
/** git subcommands that only look; branch, tag, remote and stash only with what lists. */
const GIT_READ = new Set("status diff log show blame ls-files ls-tree rev-parse describe shortlog grep show-ref cat-file check-ignore".split(" "));
const GIT_LISTS: Record<string, RegExp> = {
  branch: /^(-a|-r|-v|-vv|--all|--remotes|--list|--verbose|--show-current|--no-color|--color)$/,
  tag: /^(-l|--list)$/,
  remote: /^(-v|--verbose)$/,
};

/** A word given to a command, as a path (the value of --file=path too): is it outside? */
function argOutside(word: string, dyn: boolean, root: string): boolean {
  if (dyn) return true;
  const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : word;
  if (!value || !/^[~\/]|(^|\/)\.\.(\/|$)/.test(value)) return false;
  return outside(value, root);
}

function gitReads(args: string[], dyn: boolean[], root: string): boolean {
  let i = 0;
  // git's own options before the subcommand: only these
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    if (args[i] === "--no-pager" || args[i] === "-P") continue;
    if (args[i] === "-C" && i + 1 < args.length && !argOutside(args[i + 1]!, dyn[i + 1]!, root)) {
      i++;
      continue;
    }
    return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const restDyn = dyn.slice(i + 1);
  if (!sub || dyn[i]) return false;
  if (rest.some((a, k) => argOutside(a, restDyn[k]!, root) || /^--(output|ext-diff)/.test(a))) return false;
  if (GIT_READ.has(sub)) return true;
  if (GIT_LISTS[sub]) return rest.every((a) => GIT_LISTS[sub]!.test(a));
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "worktree") return rest[0] === "list";
  return false;
}

/** Whether a part only reads, inside the working folder: then it runs without asking, as in Claude Code. */
export function readsOnly(part: CommandPart, root: string): boolean {
  const { words, dynamic } = part;
  if (!words.length || dynamic[0] || part.writes.length || part.reads.some((r) => outside(r, root))) return false;
  const [cmd, ...args] = words as [string, ...string[]];
  const dyn = dynamic.slice(1);
  if (cmd === "git") return gitReads(args, dyn, root);
  if (!READERS.has(cmd)) return false;
  if (UNSAFE[cmd] && args.some((a) => UNSAFE[cmd]!.test(a))) return false;
  const positional = args.filter((a) => !a.startsWith("-"));
  // uniq writes its second file, hostname and date set the clock or the name, cd - and cd alone leave the folder
  if (cmd === "uniq" && positional.length > 1) return false;
  if (cmd === "hostname" && positional.length) return false;
  if (cmd === "date" && positional.some((a) => !a.startsWith("+"))) return false;
  if (cmd === "cd" && (positional.length !== 1 || positional[0] === "-")) return false;
  if (NO_PATHS.has(cmd)) return true;
  return !args.some((a, k) => argOutside(a, dyn[k]!, root));
}

/** A word as it would be typed: quoted when it has spaces or symbols. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,.\/-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** "npm run build commands", "rm -rf dist exactly", joined with "and". */
export function describeRules(rules: CommandRule[]): string {
  const items = rules.map((r) => `${r.words.map(shellWord).join(" ")}${r.exact ? " (exactly)" : " commands"}`);
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

export const sameRule = (a: CommandRule, b: CommandRule) => a.exact === b.exact && a.words.length === b.words.length && a.words.every((w, i) => w === b.words[i]);
