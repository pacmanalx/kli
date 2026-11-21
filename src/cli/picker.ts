import { bold, clay, clip, dim, green, red, wrap, yellow } from "./output.ts";

/**
 * A list chosen with the arrow keys, like the pickers of Claude Code: ↑/↓ move, Enter or the option's number
 * chooses, Esc cancels. It takes the place of the input line while open.
 */
export interface PickerOption {
  label: string;
  /** What the caller gets back (default: the label). */
  value?: string;
  /** Second column. */
  detail?: string;
  /** After the detail, muted. */
  note?: string;
  /** Why this option may not work (a missing key, a command not installed), in red. */
  problem?: string;
  /** Marked with ✔. */
  current?: boolean;
  /** Shown dim; choosing it is up to the caller (it may explain why not). */
  disabled?: boolean;
}

export interface Picker {
  title: string;
  subtitle?: string;
  options: PickerOption[];
  index: number;
  /** Letter keys that act on the highlighted option (e.g. a add · e edit · d delete). */
  actions?: { key: string; label: string }[];
  message?: { kind: "ok" | "error" | "busy"; text: string };
  /** Typing filters the options (letters and digits go to the filter, not to actions or jumps). */
  filter?: string;
  /** With a filter that matches nothing, Enter chooses the typed text (e.g. a model the list does not have). */
  typed?: boolean;
}

/** The options the filter lets through; `picker.index` points into these. */
export function visible(picker: Picker): PickerOption[] {
  const f = picker.filter?.trim().toLowerCase();
  if (!f) return picker.options;
  return picker.options.filter((o) => `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(f));
}

/** The option Enter chose, or the typed text when nothing matches; undefined when there is nothing to choose. */
export function chosen(picker: Picker): { value: string; option?: PickerOption } | undefined {
  const options = visible(picker);
  const o = options[picker.index];
  if (o) return { value: o.value ?? o.label, option: o };
  if (picker.typed && picker.filter?.trim()) return { value: picker.filter.trim() };
}

const width = (s: string) => Bun.stringWidth(s);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

/** Applies a key to the picker; says when the user chose, cancelled or pressed an action key. */
export function pickerKey(picker: Picker, key: string): "choose" | "cancel" | { action: string } | undefined {
  if (picker.filter !== undefined) {
    const edit = (next: string): undefined => {
      picker.filter = next;
      picker.index = 0;
    };
    if (key.startsWith("text:") || key.startsWith("paste:")) return edit(picker.filter + key.slice(key.indexOf(":") + 1).replace(/[\r\n]+/g, ""));
    if (key === "\x7f" || key === "\b") return edit(Array.from(picker.filter).slice(0, -1).join(""));
    if (key === "\x15") return edit(""); // Ctrl+U
  }
  const n = Math.max(1, visible(picker).length);
  switch (key) {
    case "\x1b[A":
    case "\x1bOA":
    case "\x10": // Ctrl+P
      picker.index = (picker.index - 1 + n) % n;
      return;
    case "\x1b[B":
    case "\x1bOB":
    case "\x0e": // Ctrl+N
    case "\t":
      picker.index = (picker.index + 1) % n;
      return;
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
    case "\x1b[5~":
      picker.index = 0;
      return;
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
    case "\x1b[6~":
      picker.index = n - 1;
      return;
    case "\r":
      return "choose";
    case "\x1b":
    case "\x03":
      return "cancel";
  }
  const letter = /^text:([a-z])$/i.exec(key)?.[1]?.toLowerCase();
  if (letter && picker.actions?.some((a) => a.key === letter)) return { action: letter };
  const digit = /^text:([1-9])$/.exec(key);
  if (digit && Number(digit[1]) <= n) {
    picker.index = Number(digit[1]) - 1;
    return "choose";
  }
}

/** The picker's rows, at most `maxRows` (the options scroll to keep the highlighted one in view). */
export function pickerRows(picker: Picker, cols: number, maxRows: number, color = true): string[] {
  const options = visible(picker);
  const filtering = picker.filter !== undefined;
  // a long message (what to do when ssh fails) is wrapped, not cut
  const m = picker.message;
  const message = m ? wrap(`${{ ok: "✓", error: "✕", busy: "◐" }[m.kind]} ${m.text}`, Math.max(10, cols - 4)).slice(0, 4) : [];
  // title, subtitle, the filter, blanks around the options, message, hint
  const chrome = (picker.subtitle ? 5 : 4) + (filtering ? 1 : 0) + message.length;
  const room = Math.min(options.length, Math.max(1, maxRows - chrome));
  const start = Math.max(0, Math.min(picker.index - Math.floor(room / 2), options.length - room));
  const digits = String(options.length).length;
  const labelW = Math.max(0, ...options.map((o) => width(o.label)));
  const detailW = Math.min(28, Math.max(0, ...options.map((o) => width(o.detail ?? ""))));

  const rows = [clip(" " + bold(picker.title, color), cols)];
  if (picker.subtitle) rows.push(clip(" " + dim(picker.subtitle, color), cols));
  if (filtering) rows.push(clip(` ${dim("filter", color)} ${picker.filter}${clay("▏", color)}`, cols));
  rows.push("");
  if (!options.length && filtering) {
    const typed = picker.typed && picker.filter?.trim();
    rows.push(clip("   " + dim(typed ? `nothing matches · Enter uses “${picker.filter!.trim()}”` : "nothing matches", color), cols));
  }
  for (let i = start; i < start + room; i++) {
    const o = options[i]!;
    const on = i === picker.index;
    const label = pad(o.label, labelW);
    const ink = (x: string) => (o.disabled ? dim(x, color) : x);
    const tail = [o.note ? dim(o.note, color) : "", o.problem && !o.disabled ? red(`✕ ${o.problem}`, color) : ""].filter(Boolean).join("  ");
    rows.push(
      clip(
        ` ${on ? clay("❯", color) : " "} ${dim(`${String(i + 1).padStart(digits)}.`, color && !on)} ${on ? clay(bold(label, color), color) : ink(label)}` +
          ` ${o.current ? green("✔", color) : " "}  ${ink(pad(o.detail ?? "", detailW))}  ${tail}`.trimEnd(),
        cols,
      ),
    );
  }
  rows.push("");
  if (m) for (const [i, line] of message.entries()) rows.push(clip(" " + { ok: green, error: red, busy: yellow }[m.kind]((i ? "  " : "") + line, color), cols));
  const hidden = start > 0 || start + room < options.length ? ` · ${start} above, ${options.length - start - room} below` : "";
  const actions = (picker.actions ?? []).map((a) => ` · ${a.key} ${a.label}`).join("");
  const jump = !filtering && options.length > 1 ? ` · 1-${Math.min(9, options.length)} jump` : "";
  const typing = filtering ? " · type to filter" : "";
  rows.push(clip(" " + dim(`↑/↓ choose · Enter select${jump}${typing}${actions} · Esc back${hidden}`, color), cols));
  return rows;
}
