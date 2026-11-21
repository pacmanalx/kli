import type { Stats } from "../core/stats.ts";
import { usd } from "./output.ts";
import { paint, type Tokens } from "./theme.ts";

/**
 * Charts drawn with block characters. Bars use half-height quadrants (▄ ▖): thin marks with air between rows, and a
 * half-cell resolution at the tip. Columns use eighth blocks (▁…█). One series per chart, in the series color;
 * every label stays in text tokens, and every value is printed (the numbers are the table view).
 */

const width = (s: string) => Bun.stringWidth(s);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

export const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
export const seconds = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export interface Bar {
  label: string;
  value: number;
  /** Printed at the bar's tip. */
  text: string;
  /** Printed after the tip, in muted ink. */
  note?: string;
}

/** A horizontal bar per row, all growing from the same baseline column. */
export function barChart(bars: Bar[], cols: number, t: Tokens, color: boolean): string[] {
  if (!bars.length) return [];
  const labelW = Math.min(16, Math.max(...bars.map((b) => width(b.label))));
  const tail = Math.max(...bars.map((b) => width(b.text) + (b.note ? width(b.note) + 3 : 0))) + 1;
  const area = Math.max(8, Math.min(48, cols - labelW - 3 - tail));
  const max = Math.max(...bars.map((b) => b.value)) || 1;
  return bars.map((b) => {
    const halves = b.value > 0 ? Math.max(1, Math.round((b.value / max) * area * 2)) : 0;
    const bar = "▄".repeat(Math.floor(halves / 2)) + (halves % 2 ? "▖" : "");
    const note = b.note ? "  " + paint(t.muted, b.note, color) : "";
    return ` ${pad(b.label.slice(0, labelW), labelW)}  ${paint(t.series, bar, color)}${" ".repeat(Math.ceil(halves / 2) ? 1 : 0)}${b.text}${note}`;
  });
}

const EIGHTHS = " ▁▂▃▄▅▆▇█";

/** Vertical columns with a gap between them, a baseline, the peak labeled, and the first and last labels below. */
export function columnChart(points: { label: string; value: number }[], cols: number, height: number, t: Tokens, color: boolean): string[] {
  const fit = Math.max(1, Math.floor((cols - 2) / 2));
  const shown = points.slice(-fit);
  if (!shown.length) return [];
  const max = Math.max(...shown.map((p) => p.value));
  const peak = shown.findIndex((p) => p.value === max && max > 0);
  const levels = shown.map((p) => (max ? Math.round((p.value / max) * height * 8) : 0));
  const rows: string[] = [];
  if (peak >= 0) rows.push(" " + " ".repeat(peak * 2) + String(max));
  for (let r = height - 1; r >= 0; r--) {
    let row = " ";
    for (const level of levels) {
      const cell = Math.max(0, Math.min(8, level - r * 8));
      row += paint(t.series, EIGHTHS[cell]!, color && cell > 0) + " ";
    }
    rows.push(row.trimEnd());
  }
  rows.push(" " + paint(t.baseline, "─".repeat(shown.length * 2 - 1), color));
  const first = shown[0]!.label;
  const last = shown.at(-1)!.label;
  const gap = Math.max(1, shown.length * 2 - 1 - width(first) - width(last));
  rows.push(" " + paint(t.muted, shown.length > 1 ? first + " ".repeat(gap) + last : first, color));
  return rows;
}

/** The whole `kli stats` report (or `/stats` for one session, with `title` and no per-day chart). */
export function statsReport(s: Stats, title: string, cols: number, t: Tokens, color: boolean): string[] {
  const bold = (x: string) => (color ? `\x1b[1m${x}\x1b[0m` : x);
  const heading = (x: string) => paint(t.secondary, bold(x), color);
  const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const out = [" " + bold(title), ""];
  if (!s.prompts) return [...out, " " + paint(t.muted, "no prompts yet", color)];

  const tokens = `${compact(s.inputTokens + s.outputTokens)} tokens ${paint(t.muted, `(${compact(s.inputTokens)} in → ${compact(s.outputTokens)} out)`, color)}`;
  out.push(
    " " +
      [plural(s.sessions, "session"), plural(s.prompts, "prompt"), tokens, s.medianMs !== undefined ? `median ${seconds(s.medianMs)}` : "", s.costUsd ? `${usd(s.costUsd)} reported` : ""]
        .filter(Boolean)
        .join("   "),
  );
  const outcome = (icon: string, c: Tokens[keyof Tokens], text: string) => `${paint(c, icon, color)} ${text}`;
  out.push(
    " " +
      [
        outcome("✓", t.good, `${s.outcomes.answered} answered`),
        s.fallbacks ? outcome("↷", t.warning, plural(s.fallbacks, "fallback")) : "",
        s.outcomes.failed ? outcome("✕", t.critical, `${s.outcomes.failed} failed`) : "",
        s.outcomes.interrupted ? outcome("■", t.muted, `${s.outcomes.interrupted} interrupted`) : "",
      ]
        .filter(Boolean)
        .join("   "),
  );

  const answered = s.providers.filter((p) => p.answers);
  if (answered.length === 1) {
    // one provider: a single bar says nothing a number does not; the number is the chart
    const p = answered[0]!;
    out.push(
      "",
      " " +
        `${p.provider} · ${p.model}   ${plural(p.answers, "answer")}   median ${seconds(p.medianMs)} · p90 ${seconds(p.p90Ms)}   ` +
        paint(t.muted, `${compact(p.inputTokens)} in → ${compact(p.outputTokens)} out${p.costUsd ? ` · ${usd(p.costUsd)}` : ""}`, color),
    );
  } else if (answered.length) {
    out.push("", " " + heading("Median latency by provider"));
    out.push(
      ...barChart(
        answered.map((p) => ({
          label: p.provider,
          value: p.medianMs,
          text: seconds(p.medianMs),
          note: `p90 ${seconds(p.p90Ms)} · ${plural(p.answers, "answer")}${p.failures ? ` · ${plural(p.failures, "failure")}` : ""}`,
        })),
        cols,
        t,
        color,
      ),
    );
    const byTokens = [...answered].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    out.push("", " " + heading("Tokens by provider"));
    out.push(
      ...barChart(
        byTokens.map((p) => ({ label: p.provider, value: p.inputTokens + p.outputTokens, text: compact(p.inputTokens + p.outputTokens), note: `${compact(p.inputTokens)} in → ${compact(p.outputTokens)} out${p.costUsd ? ` · ${usd(p.costUsd)}` : ""}` })),
        cols,
        t,
        color,
      ),
    );
  }
  const failedOnly = s.providers.filter((p) => !p.answers);
  if (failedOnly.length)
    out.push("", " " + paint(t.muted, `never answered: ${failedOnly.map((p) => `${p.provider} (${plural(p.failures, "failure")})`).join(", ")}`, color));

  if (s.days.length) {
    out.push("", " " + heading("Answers per day"));
    out.push(...columnChart(s.days.map((d) => ({ label: d.date.slice(5), value: d.answers })), cols, 4, t, color));
  }
  return out;
}
