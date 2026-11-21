import { bold, clay, clip, dim, green, red, yellow } from "./output.ts";

/**
 * A form in the place of the input line: text fields, choices (←/→), checklists (Space) and buttons. ↑/↓ or Tab
 * move between them, Esc cancels. The form only edits its values; the caller decides what a button or a list does.
 */
export type FormField =
  | {
      type: "text";
      key: string;
      label: string;
      value: string;
      placeholder?: string;
      /** Shown while the field has focus. */
      hint?: string;
      /** Enter asks the caller for a list to choose the value from. */
      list?: boolean;
      /** Shown as dots (an API key). */
      secret?: boolean;
    }
  | { type: "choice"; key: string; label: string; value: string; options: { value: string; label: string }[] }
  | { type: "checks"; key: string; label: string; values: string[]; options: string[]; at: number };

export interface Form {
  title: string;
  subtitle?: string;
  fields: FormField[];
  buttons: string[];
  /** Focus: a field, or past the fields, a button. */
  index: number;
  /** Caret in the focused text field. */
  cursor: number;
  message?: { kind: "busy" | "ok" | "error" | "info"; text: string };
}

export type FormAction =
  | { kind: "button"; button: string }
  | { kind: "list"; key: string }
  | { kind: "change"; key: string }
  | { kind: "cancel" }
  | undefined;

const width = (s: string) => Bun.stringWidth(s);

export function value(form: Form, key: string): string {
  const f = form.fields.find((x) => x.key === key);
  return f && f.type !== "checks" ? f.value : "";
}

export function checked(form: Form, key: string): string[] {
  const f = form.fields.find((x) => x.key === key);
  return f?.type === "checks" ? f.values : [];
}

function focus(form: Form, index: number): void {
  const stops = form.fields.length + form.buttons.length;
  form.index = (index + stops) % stops;
  const f = form.fields[form.index];
  form.cursor = f?.type === "text" ? Array.from(f.value).length : 0;
}

/** Applies a key; says when a button was pressed, a list was asked for, a choice changed, or the form was left. */
export function formKey(form: Form, key: string): FormAction {
  const field = form.fields[form.index];
  switch (key) {
    case "\x1b":
    case "\x03":
      return { kind: "cancel" };
    case "\x1b[A":
    case "\x1bOA":
    case "\x1b[Z": // Shift+Tab
      focus(form, form.index - 1);
      return;
    case "\x1b[B":
    case "\x1bOB":
    case "\t":
      focus(form, form.index + 1);
      return;
  }
  if (!field) {
    // the buttons, in one row
    const at = form.index - form.fields.length;
    if (key === "\x1b[D" || key === "\x1bOD") focus(form, form.fields.length + ((at - 1 + form.buttons.length) % form.buttons.length));
    else if (key === "\x1b[C" || key === "\x1bOC") focus(form, form.fields.length + ((at + 1) % form.buttons.length));
    else if (key === "\r" || key === "text: ") return { kind: "button", button: form.buttons[at]! };
    return;
  }
  if (field.type === "choice") {
    const i = field.options.findIndex((o) => o.value === field.value);
    const step = key === "\x1b[D" || key === "\x1bOD" ? -1 : key === "\x1b[C" || key === "\x1bOC" || key === "text: " ? 1 : 0;
    if (step) {
      field.value = field.options[(i + step + field.options.length) % field.options.length]!.value;
      return { kind: "change", key: field.key };
    }
    if (key === "\r") focus(form, form.index + 1);
    return;
  }
  if (field.type === "checks") {
    if (key === "\x1b[D" || key === "\x1bOD") field.at = (field.at - 1 + field.options.length) % field.options.length;
    else if (key === "\x1b[C" || key === "\x1bOC") field.at = (field.at + 1) % field.options.length;
    else if (key === "text: ") {
      const option = field.options[field.at]!;
      field.values = field.values.includes(option) ? field.values.filter((v) => v !== option) : [...field.values, option];
      return { kind: "change", key: field.key };
    } else if (key === "\r") focus(form, form.index + 1);
    return;
  }
  // a text field
  const chars = Array.from(field.value);
  const set = (next: string[], cursor: number) => {
    field.value = next.join("");
    form.cursor = Math.max(0, Math.min(next.length, cursor));
  };
  if (key.startsWith("text:") || key.startsWith("paste:")) {
    const add = Array.from(key.slice(key.indexOf(":") + 1).replace(/[\r\n]+/g, ""));
    chars.splice(form.cursor, 0, ...add);
    set(chars, form.cursor + add.length);
    return { kind: "change", key: field.key };
  }
  switch (key) {
    case "\r":
      if (field.list) return { kind: "list", key: field.key };
      focus(form, form.index + 1);
      return;
    case "\x7f":
    case "\b":
      if (form.cursor > 0) {
        chars.splice(form.cursor - 1, 1);
        set(chars, form.cursor - 1);
        return { kind: "change", key: field.key };
      }
      return;
    case "\x1b[3~":
      chars.splice(form.cursor, 1);
      set(chars, form.cursor);
      return { kind: "change", key: field.key };
    case "\x15": // Ctrl+U
      set([], 0);
      return { kind: "change", key: field.key };
    case "\x1b[D":
    case "\x1bOD":
      form.cursor = Math.max(0, form.cursor - 1);
      return;
    case "\x1b[C":
    case "\x1bOC":
      form.cursor = Math.min(chars.length, form.cursor + 1);
      return;
    case "\x01":
    case "\x1b[H":
    case "\x1bOH":
      form.cursor = 0;
      return;
    case "\x05":
    case "\x1b[F":
    case "\x1bOF":
      form.cursor = chars.length;
      return;
  }
}

/** The form's rows, and where the caret goes (row and column, both from 0) when a text field has focus. */
export function formRows(form: Form, cols: number, color = true): { rows: string[]; cursor?: [number, number] } {
  const labelW = Math.max(...form.fields.map((f) => width(f.label)));
  const valueCol = 3 + labelW + 2; // " ❯ " + label + two spaces
  const room = Math.max(10, cols - valueCol - 1);
  const rows = [clip(" " + bold(form.title, color), cols)];
  if (form.subtitle) rows.push(clip(" " + dim(form.subtitle, color), cols));
  rows.push("");
  let cursor: [number, number] | undefined;

  form.fields.forEach((f, i) => {
    const on = i === form.index;
    const head = ` ${on ? clay("❯", color) : " "} ${(on ? (s: string) => clay(bold(s, color), color) : (s: string) => s)(f.label.padEnd(labelW))}  `;
    if (f.type === "text") {
      const shown = f.value ? f.value : f.placeholder ? dim(f.placeholder, color) : "";
      const hint = on && f.hint ? "   " + dim(f.hint, color) : "";
      // a long value scrolls so the caret stays in view
      const chars = f.secret ? Array.from(f.value, () => "•") : Array.from(f.value);
      let start = 0;
      if (on) while (width(chars.slice(start, form.cursor).join("")) > room - 1) start++;
      const visible = f.value ? chars.slice(start).join("") : shown;
      if (on) cursor = [rows.length, valueCol + width(chars.slice(start, form.cursor).join(""))];
      rows.push(clip(head + visible + hint, cols));
    } else if (f.type === "choice") {
      const label = f.options.find((o) => o.value === f.value)?.label ?? f.value;
      rows.push(clip(head + (on ? `${dim("‹", color)} ${label} ${dim("›", color)}` : label), cols));
    } else {
      // a checklist wraps under its own column
      const items = f.options.map((o, j) => {
        const box = f.values.includes(o) ? green("◉", color) : dim("○", color);
        const text = on && j === f.at ? clay(bold(o, color), color) : o;
        return { text: `${box} ${text}`, w: width(o) + 2 };
      });
      let line = head;
      let used = 0;
      for (const item of items) {
        if (used && used + 2 + item.w > room) {
          rows.push(line);
          line = " ".repeat(valueCol);
          used = 0;
        }
        line += (used ? "  " : "") + item.text;
        used += (used ? 2 : 0) + item.w;
      }
      rows.push(line);
    }
  });

  rows.push("");
  const buttons = form.buttons.map((b, j) => {
    const on = form.index === form.fields.length + j;
    return on ? clay(bold(`[ ${b} ]`, color), color) : dim(`[ ${b} ]`, color);
  });
  rows.push("   " + buttons.join("  "));
  rows.push("");
  const m = form.message;
  if (m) {
    const paint = { busy: yellow, ok: green, error: red, info: dim }[m.kind];
    const icon = { busy: "◐", ok: "✓", error: "✕", info: "·" }[m.kind];
    rows.push(clip(" " + paint(`${icon} ${m.text}`, color), cols));
  }
  const f = form.fields[form.index];
  const keys =
    f?.type === "text"
      ? `type to edit${f.list ? " · Enter lists the choices" : ""}`
      : f?.type === "choice"
        ? "←/→ change"
        : f?.type === "checks"
          ? "←/→ move · Space toggles"
          : "←/→ button · Enter presses it";
  rows.push(clip(" " + dim(`↑/↓ field · ${keys} · Esc cancel`, color), cols));
  return { rows, cursor };
}
