import { expect, test } from "bun:test";
import { checked, formKey, formRows, value, type Form } from "../src/cli/form.ts";

const make = (): Form => ({
  title: "New provider",
  fields: [
    { type: "text", key: "name", label: "Name", value: "" },
    { type: "choice", key: "kind", label: "Kind", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { type: "text", key: "model", label: "Model", value: "", list: true },
    { type: "checks", key: "profiles", label: "Profiles", values: ["p1"], options: ["p1", "p2"], at: 0 },
  ],
  buttons: ["Save", "Cancel"],
  index: 0,
  cursor: 0,
});

test("typing edits the focused text field, with a caret", () => {
  const f = make();
  formKey(f, "text:gibor");
  formKey(f, "\x1b[D");
  formKey(f, "text:b");
  expect(value(f, "name")).toBe("gibobr"); // the b went before the r
  formKey(f, "\x7f");
  expect(value(f, "name")).toBe("gibor");
  formKey(f, "\x15");
  expect(value(f, "name")).toBe("");
});

test("↑/↓ move between fields and buttons; ←/→ change a choice; Space toggles a check", () => {
  const f = make();
  formKey(f, "\x1b[B");
  expect(formKey(f, "\x1b[C")).toEqual({ kind: "change", key: "kind" });
  expect(value(f, "kind")).toBe("b");
  formKey(f, "\x1b[C");
  expect(value(f, "kind")).toBe("a");
  formKey(f, "\x1b[B");
  formKey(f, "\x1b[B");
  formKey(f, "\x1b[C");
  formKey(f, "text: ");
  expect(checked(f, "profiles")).toEqual(["p1", "p2"]);
  formKey(f, "\x1b[B");
  expect(formKey(f, "\r")).toEqual({ kind: "button", button: "Save" });
  formKey(f, "\x1b[C");
  expect(formKey(f, "\r")).toEqual({ kind: "button", button: "Cancel" });
  formKey(f, "\x1b[B");
  expect(f.index).toBe(0);
  expect(formKey(f, "\x1b")).toEqual({ kind: "cancel" });
});

test("Enter on a field with a list asks for it; the caret is placed after the label column", () => {
  const f = make();
  f.index = 2;
  expect(formKey(f, "\r")).toEqual({ kind: "list", key: "model" });
  formKey(f, "text:lfm3");
  const { rows, cursor } = formRows(f, 80, false);
  expect(rows).toContain(" ❯ Model     lfm3");
  expect(cursor).toEqual([rows.indexOf(" ❯ Model     lfm3"), 13 + 4]);
  expect(rows).toContain("   Profiles  ◉ p1  ○ p2");
});
