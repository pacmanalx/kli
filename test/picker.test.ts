import { expect, test } from "bun:test";
import { chosen, pickerKey, pickerRows, type Picker } from "../src/cli/picker.ts";

const make = (n = 3, index = 0): Picker => ({
  title: "Select a provider · kli.chat",
  subtitle: "Only the destinations this profile allows.",
  options: Array.from({ length: n }, (_, i) => ({ label: `p${i + 1}`, detail: `model-${i + 1}`, current: i === 1 })),
  index,
});

test("arrows move and wrap around, Home/End jump to the ends", () => {
  const p = make();
  pickerKey(p, "\x1b[B");
  expect(p.index).toBe(1);
  pickerKey(p, "\x1b[B");
  pickerKey(p, "\x1b[B");
  expect(p.index).toBe(0);
  pickerKey(p, "\x1b[A");
  expect(p.index).toBe(2);
  pickerKey(p, "\x1b[H");
  expect(p.index).toBe(0);
  pickerKey(p, "\x1b[F");
  expect(p.index).toBe(2);
});

test("Enter or a number chooses, Esc and Ctrl+C cancel, other keys are ignored", () => {
  const p = make();
  expect(pickerKey(p, "\r")).toBe("choose");
  expect(pickerKey(p, "text:3")).toBe("choose");
  expect(p.index).toBe(2);
  expect(pickerKey(p, "text:4")).toBeUndefined();
  expect(pickerKey(p, "text:x")).toBeUndefined();
  expect(p.index).toBe(2);
  expect(pickerKey(p, "\x1b")).toBe("cancel");
  expect(pickerKey(p, "\x03")).toBe("cancel");
});

test("rows mark the highlighted option and the current one, with aligned columns", () => {
  const rows = pickerRows(make(3, 0), 80, 20, false);
  expect(rows[0]).toBe(" Select a provider · kli.chat");
  expect(rows[1]).toBe(" Only the destinations this profile allows.");
  expect(rows.slice(3, 6)).toEqual([" ❯ 1. p1    model-1", "   2. p2 ✔  model-2", "   3. p3    model-3"]);
  expect(rows.at(-1)).toBe(" ↑/↓ choose · Enter select · 1-3 jump · Esc back");
});

test("a long list scrolls to keep the highlighted option in view", () => {
  const rows = pickerRows(make(12, 10), 80, 9, false);
  expect(rows).toHaveLength(9);
  const shown = rows.slice(3, 7).map((r) => r.trim().split(/\s+/).find((w) => /^p\d+$/.test(w)));
  expect(shown).toEqual(["p9", "p10", "p11", "p12"]);
  expect(rows.find((r) => r.startsWith(" ❯"))).toContain("p11");
  expect(rows.at(-1)).toContain("8 above, 0 below");
});

test("with a filter, typing narrows the list (digits too), and a name it lacks can be typed", () => {
  const p: Picker = { title: "Models", options: [{ label: "lfm3:latest" }, { label: "qwen3:14b" }, { label: "qwen2.5:3b", detail: "small" }], index: 0, filter: "", typed: true };
  for (const k of ["text:q", "text:w", "text:e", "text:n", "text:3"]) expect(pickerKey(p, k)).toBeUndefined();
  expect(chosen(p)).toEqual({ value: "qwen3:14b", option: { label: "qwen3:14b" } });
  pickerKey(p, "\x7f");
  pickerKey(p, "text:2");
  expect(chosen(p)?.value).toBe("qwen2.5:3b");
  pickerKey(p, "\x15");
  pickerKey(p, "text:gemma");
  expect(chosen(p)).toEqual({ value: "gemma" });
  expect(pickerRows(p, 80, 20, false).join("\n")).toContain("nothing matches · Enter uses “gemma”");
});

test("a long message is wrapped under the list, not cut at the edge", () => {
  const p: Picker = { title: "Model › gpubox", options: [], index: 0, filter: "", message: { kind: "error", text: "ssh tunnel to admin@192.168.10.230 failed: accept its key by hand: ssh -J desk admin@192.168.10.230 true" } };
  const rows = pickerRows(p, 50, 20, false);
  expect(rows.slice(-4, -1)).toEqual([" ✕ ssh tunnel to admin@192.168.10.230 failed:", "   accept its key by hand: ssh -J desk", "   admin@192.168.10.230 true"]);
});
