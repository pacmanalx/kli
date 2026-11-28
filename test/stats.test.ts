import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barChart, columnChart } from "../src/cli/charts.ts";
import { TOKENS } from "../src/cli/theme.ts";
import { collectStats, percentile } from "../src/core/stats.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-stats-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const now = new Date(2026, 9, 30, 12, 0, 0);
const at = (daysAgo: number, minute = 0) => new Date(2026, 9, 30 - daysAgo, 10, minute).toISOString();
const write = (id: string, events: object[]) =>
  writeFileSync(join(dir, `${id}.jsonl`), events.map((e) => JSON.stringify({ session: id, ...e })).join("\n") + "\n");

write("s1", [
  { ts: at(0), type: "start", user: "t", surface: "cli", profile: "kli.chat" },
  { ts: at(0, 1), type: "prompt" },
  { ts: at(0, 1), type: "response", provider: "desk", model: "qwen", ms: 300, inputTokens: 50, outputTokens: 5 },
  { ts: at(0, 2), type: "prompt" },
  { ts: at(0, 2), type: "failure", provider: "desk", ms: 0, error: "x", afterText: false },
  { ts: at(0, 2), type: "fallback", from: "desk", to: "local", reason: "x" },
  { ts: at(0, 2), type: "response", provider: "local", model: "lfm3", ms: 900, inputTokens: 40, outputTokens: 10 },
  { ts: at(0, 3), type: "prompt" },
  { ts: at(0, 3), type: "interrupted", provider: "desk", ms: 2000, afterText: true },
]);
write("s2", [
  { ts: at(2), type: "start", user: "t", surface: "cli", profile: "kli.chat" },
  { ts: at(2, 1), type: "prompt" },
  { ts: at(2, 1), type: "response", provider: "desk", model: "qwen", ms: 500, inputTokens: 10, outputTokens: 5 },
  { ts: at(2, 2), type: "prompt" },
  { ts: at(2, 2), type: "failure", provider: "gemini", ms: 100, error: "y", afterText: false },
]);
write("old", [
  { ts: at(40), type: "start", user: "t", surface: "cli", profile: "kli.chat" },
  { ts: at(40, 1), type: "prompt" },
  { ts: at(40, 1), type: "response", provider: "desk", model: "qwen", ms: 9999 },
]);

test("percentile is nearest-rank", () => {
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  expect(percentile([], 0.5)).toBe(0);
});

test("collects outcomes, providers and days inside the period", () => {
  const s = collectStats(dir, { days: 7, now });
  expect(s).toMatchObject({ sessions: 2, prompts: 5, fallbacks: 1, inputTokens: 100, outputTokens: 20, medianMs: 500 });
  expect(s.outcomes).toEqual({ answered: 3, failed: 1, interrupted: 1 });
  expect(s.providers.map((p) => [p.provider, p.answers, p.medianMs, p.failures])).toEqual([
    ["desk", 2, 300, 1],
    ["local", 1, 900, 0],
    ["gemini", 0, 0, 1],
  ]);
  expect(s.days).toHaveLength(7);
  expect(s.days.at(-1)).toEqual({ date: "2026-10-30", answers: 2 });
  expect(s.days.at(-3)).toEqual({ date: "2026-10-28", answers: 1 });
});

test("one session only, with no per-day series", () => {
  const s = collectStats(dir, { sessions: ["s2"] });
  expect(s).toMatchObject({ sessions: 1, prompts: 2, outcomes: { answered: 1, failed: 1, interrupted: 0 }, days: [] });
});

test("bars grow from one baseline, half a cell at a time, with the value at the tip", () => {
  const lines = barChart([{ label: "desk", value: 1, text: "0.3s" }, { label: "gemini", value: 4, text: "1.2s", note: "p90 2.0s" }], 40, TOKENS.dark, false);
  expect(lines[0]).toMatch(/^ desk    ▄+▖? 0\.3s$/);
  expect(lines[1]).toMatch(/^ gemini  ▄+ 1\.2s  p90 2\.0s$/);
  expect(lines[0]!.indexOf("▄")).toBe(lines[1]!.indexOf("▄"));
});

test("columns: eighth blocks, a gap between them, the peak labeled", () => {
  const rows = columnChart([{ label: "10-28", value: 1 }, { label: "10-29", value: 0 }, { label: "10-30", value: 2 }], 40, 2, TOKENS.dark, false);
  expect(rows).toEqual(["     2", "     █", " █   █", " ─────", " 10-28 10-30"]);
});

test("one provider gets a line of numbers, not a one-bar chart", async () => {
  const { statsReport } = await import("../src/cli/charts.ts");
  const lines = statsReport(collectStats(dir, { sessions: ["s2"] }), "s2", 80, TOKENS.dark, false);
  expect(lines.some((l) => l.includes("▄"))).toBe(false);
  expect(lines.join("\n")).toContain("desk · qwen   1 answer   median 0.5s · p90 0.5s");
});

test("a prompt that used tools has a response per step, and was answered once", () => {
  write("tools", [
    { ts: at(1), type: "start", user: "t", surface: "cli" },
    { ts: at(1, 1), type: "prompt" },
    { ts: at(1, 1), type: "response", provider: "mac/ollama", model: "lfm3", ms: 100, inputTokens: 10, outputTokens: 2 },
    { ts: at(1, 1), type: "tool", name: "Bash", detail: "Bash(ls)", ok: true, ms: 5, summary: "exit 0" },
    { ts: at(1, 2), type: "response", provider: "mac/ollama", model: "lfm3", ms: 200, inputTokens: 20, outputTokens: 8 },
  ]);
  const s = collectStats(dir, { sessions: ["tools"], now });
  expect(s).toMatchObject({ prompts: 1, outcomes: { answered: 1, failed: 0, interrupted: 0 }, inputTokens: 30, outputTokens: 10 });
  expect(s.providers[0]).toMatchObject({ provider: "mac/ollama", answers: 2 });
});
