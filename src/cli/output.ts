import type { NodeResult, RoutedResponse, StackResult } from "../core/index.ts";

type Stream = { isTTY?: boolean };

/** Color only on a real terminal, and never when NO_COLOR is set. */
export const useColor = (stream: Stream): boolean => !!stream.isTTY && !process.env.NO_COLOR;

const sgr = (code: string) => (text: string, on: boolean) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);

export const bold = sgr("1");
export const dim = sgr("2");
export const red = sgr("31");
export const green = sgr("32");
export const yellow = sgr("33");
export const clay = sgr("38;2;196;122;74");

/** Visible width, ignoring color codes. */
export const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Cuts a row to the terminal width without breaking color codes (it simply stops adding visible characters). */
export function clip(row: string, cols: number): string {
  if (Bun.stringWidth(row) <= cols) return row;
  let out = "";
  let seen = 0;
  for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      const w = Bun.stringWidth(ch);
      if (seen + w > cols - 1) return out + "…\x1b[0m";
      out += ch;
      seen += w;
    }
  }
  return out;
}

/** Word wrap to `max` columns, keeping indentation and breaking words that do not fit on a line. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.replace(/\t/g, "    ").split("\n")) {
    let line = "";
    for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
      if (Bun.stringWidth(line + token) <= max) {
        line += token;
        continue;
      }
      if (/^\s+$/.test(token)) {
        out.push(line.trimEnd());
        line = "";
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = "";
      let rest = token;
      while (Bun.stringWidth(rest) > max) {
        let cut = "";
        for (const ch of rest) {
          if (Bun.stringWidth(cut + ch) > max) break;
          cut += ch;
        }
        out.push(cut);
        rest = rest.slice(cut.length);
      }
      line = rest;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** provider · model · seconds · tokens */
export function measures(r: RoutedResponse): string {
  const tokens = r.inputTokens !== undefined ? ` · ${r.inputTokens}→${r.outputTokens ?? "?"} tokens` : "";
  return `${r.provider} · ${r.model || "default model"} · ${(r.ms / 1000).toFixed(1)}s${tokens}${r.costUsd !== undefined ? ` · ${usd(r.costUsd)}` : ""}`;
}

export function usd(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** One node of a stack, measured: ✓ a  gpu-box/ollama/lfm3 · 3.1s · first token 0.4s · 1219→310 tokens · 98 tok/s. */
/**
 * A node's line when it ended. `reason`: why it failed or was skipped goes at the end; the stack's tree puts it on
 * lines of its own instead, because the screen cuts the end of a long line.
 */
export function nodeLine(r: NodeResult, color: boolean, reason = true): string {
  const mark = { ok: green("✓", color), failed: red("✕", color), skipped: yellow("–", color), interrupted: yellow("■", color) }[r.status];
  const model = r.answeredBy && r.answeredBy !== r.model ? `${r.answeredBy} (fallback of ${r.model})` : r.model;
  // a judge's rounds go with its time, which they add up to (at the end of a long line, the screen cut them off)
  const parts = [`${(r.ms / 1000).toFixed(1)}s${r.rounds ? ` in ${r.rounds} rounds` : ""}`];
  if (r.firstTokenMs !== undefined) parts.push(`first token ${(r.firstTokenMs / 1000).toFixed(1)}s`);
  if (r.inputTokens !== undefined) parts.push(`${r.inputTokens}→${r.outputTokens ?? "?"} tokens${r.thinkingTokens ? ` (${r.thinkingTokens} thinking)` : ""}`);
  if (r.tokensPerSecond !== undefined) parts.push(`${r.tokensPerSecond} tok/s`);
  if (r.costUsd !== undefined) parts.push(usd(r.costUsd));
  if (r.tools.length) {
    const failed = r.tools.filter((t) => !t.ok).length;
    // refused: what no one in a stack can allow (a command it may not run), so its answer may lack what that gave
    const refused = r.tools.filter((t) => t.refused).length;
    parts.push(`${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}${failed ? ` (${failed} failed${refused ? `, ${refused} refused` : ""})` : ""}`);
  }
  if (r.contributions) parts.push(`used ${Object.entries(r.contributions).map(([n, v]) => `${n} ${v}%`).join(" · ")}`);
  const judged = r.verdict && `adherence ${r.verdict.judged.map((j) => `${j.node} ${j.adherence}`).join(" · ")}`;
  if (judged) parts.push(judged);
  if (r.choice) parts.push(`chose ${r.choice.node} (${r.choice.label}) by ${r.choice.by}`);
  if (r.changes) parts.push(changesSummary(r));
  if (r.grounding) {
    const g = r.grounding;
    parts.push(`${g.items.length} excerpt${g.items.length === 1 ? "" : "s"} · ${g.tokens} tokens${g.cut ? ` (${g.cut} left out)` : ""}`);
    const failed = g.sources.filter((s) => s.error);
    if (failed.length) parts.push(failed.map((s) => `${s.name}: ${s.error}`).join(" · "));
  }
  if (r.status === "skipped") return `${mark} ${bold(r.node, color)}  ${dim(`${model} · skipped${reason ? `: ${r.error}` : ""}`, color)}`;
  // a judge stopped, or failing in a later round, keeps what it judged before
  if (r.status === "interrupted") return `${mark} ${bold(r.node, color)}  ${dim(`${model} · interrupted${judged ? ` · ${judged}` : ""}`, color)}`;
  const tail =
    r.status === "failed"
      ? reason
        ? red(r.error ?? "failed", color) + (judged ? dim(` · ${judged}`, color) : "")
        : red("failed", color) + dim(` · ${parts.join(" · ")}`, color)
      : dim(parts.join(" · "), color);
  return `${mark} ${bold(r.node, color)}  ${dim(model, color)} · ${tail}`;
}

/** What a node that writes changed, in a few words: 3 files +40 −5 · check passed (in your folder, when it worked there). */
export function changesSummary(r: NodeResult): string {
  const c = r.changes;
  if (!c) return "";
  const files = c.files.length ? `${c.files.length} file${c.files.length === 1 ? "" : "s"} +${c.added} −${c.removed}${c.inFolder ? " in your folder" : ""}` : "no file changed";
  const check = r.check ? (r.check.ok ? " · check passed" : ` · check failed (${r.check.code === null ? "stopped" : `exit ${r.check.code}`})`) : "";
  return files + check;
}

/** A stack's answer in a few words, like `measures` for a model: stack compara · 18.5s · 4470→134 tokens. */
export function stackMeasures(r: StackResult): string {
  const tokens = r.inputTokens !== undefined ? ` · ${r.inputTokens}→${r.outputTokens ?? "?"} tokens` : "";
  return `stack ${r.name} · ${(r.ms / 1000).toFixed(1)}s${tokens}${r.costUsd !== undefined ? ` · ${usd(r.costUsd)}` : ""}`;
}

/** The line after a stack's answers: how long it took, what the nodes used, and what running side by side saved. */
export function stackFooter(r: StackResult, session: string, color: boolean): string {
  const answered = r.nodes.filter((n) => n.status === "ok").length;
  const parts = [`stack ${r.name}`, `${(r.ms / 1000).toFixed(1)}s`, `${answered} of ${r.nodes.length} nodes answered`];
  if (r.inputTokens !== undefined) parts.push(`${r.inputTokens}→${r.outputTokens ?? "?"} tokens`);
  if (r.costUsd !== undefined) parts.push(usd(r.costUsd));
  const saved = r.nodeMs - r.ms;
  if (saved >= 1000) parts.push(`side by side saved ${(saved / 1000).toFixed(1)}s`);
  return dim([...parts, session].join(" · "), color);
}

/** The measurements line after each response (goes to stderr, so it never mixes with the answer). */
export function footer(r: RoutedResponse, session: string, color: boolean): string {
  const line = dim(`${measures(r)} · ${session}`, color);
  if (!r.fallback) return line;
  const short = (reason: string) => (reason.length > 90 ? reason.slice(0, 89) + "…" : reason);
  const failures = r.fallback.failed.map((f) => yellow(`✕ ${f.provider}: ${short(f.reason)}`, color));
  return [...failures, yellow(`↷ answered by the fallback ${r.ref}`, color), line].join("\n");
}
