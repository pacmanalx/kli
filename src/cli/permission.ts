import { describeRules, type Answer, type DiffLine, type PermissionRequest } from "../core/index.ts";
import type { Overlay } from "./overlay.ts";
import { bold, clip, dim, green, red, yellow } from "./output.ts";
import { pickerKey, pickerRows, type Picker } from "./picker.ts";

/** A diff for the screen: line numbers, + and − colored, long lines cut. */
export function diffRows(diff: DiffLine[], cols: number, max: number, color = true): string[] {
  const shown = diff.slice(0, max);
  const digits = String(Math.max(1, ...shown.map((d) => d.line))).length;
  const rows = shown.map((d) => {
    const text = `${String(d.line).padStart(digits)} ${d.op} ${d.text}`;
    const paint = d.op === "+" ? green : d.op === "-" ? red : dim;
    return clip("   " + paint(text, color), cols);
  });
  if (diff.length > shown.length) rows.push("   " + dim(`… ${diff.length - shown.length} more lines`, color));
  return rows;
}

/** A command for the screen, in as many lines as it takes. */
function wrapCommand(command: string, cols: number): string[] {
  const w = Math.max(20, cols - 6);
  const out: string[] = [];
  for (const line of command.split("\n")) for (let i = 0; i < Math.max(1, line.length); i += w) out.push("   " + yellow((i ? "  " : "$ ") + line.slice(i, i + w), true));
  return out;
}

/**
 * The question before a tool writes or runs, as in Claude Code: what would change, then yes, yes for the rest of
 * the session, or no (and the person says what to do instead). Esc is no.
 */
export function permissionOverlay(request: PermissionRequest, done: (answer: Answer) => void): Overlay {
  const always =
    request.scope.kind === "edits"
      ? "Yes, allow all edits during this session"
      : request.scope.kind === "command"
        ? `Yes, and don't ask again this session for ${describeRules(request.scope.rules)}`
        : undefined;
  const answers: Answer[] = always ? ["yes", "always", "no"] : ["yes", "no"];
  const picker: Picker = {
    title: "Do you want to go ahead?",
    options: [{ label: "Yes" }, ...(always ? [{ label: always }] : []), { label: "No, and tell Kli what to do differently (esc)" }],
    index: 0,
  };
  let answered = false;
  const answer = (a: Answer) => {
    if (answered) return;
    answered = true;
    done(a);
  };
  return {
    rows: (cols, maxRows) => {
      // the choices first (title, blank, options, blank, hint); the preview gets what is left
      const choices = picker.options.length + 4 + (request.scope.kind === "once" ? 1 : 0);
      const room = Math.max(2, maxRows - choices - 2);
      const preview: string[] = [];
      if (request.command) preview.push(...wrapCommand(request.command, cols).slice(0, room));
      if (request.diff?.length) preview.push(...diffRows(request.diff, cols, Math.max(1, room - preview.length - 1)));
      // why there is no "don't ask again"
      const once = request.scope.kind === "once" ? [clip("   " + dim(`asks every time: ${request.scope.why}`, true), cols)] : [];
      const head = [clip(" " + bold(request.title, true) + dim(` · ${request.tool} needs your permission`, true), cols), ...preview, ...once, ""];
      return { rows: [...head, ...pickerRows(picker, cols, choices)] };
    },
    key: (key) => {
      const r = pickerKey(picker, key);
      if (r === "cancel") answer("no");
      else if (r === "choose") answer(answers[picker.index]!);
    },
  };
}
