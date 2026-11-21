import { stackOrder, stackOutputs } from "../../core/stack.ts";
import type { StackConfig, StackNode } from "../../core/types.ts";

/**
 * The stack builder's edits, kept apart from the page so they can be tested: each takes a stack and gives a new one,
 * cleaned of empty fields, so what is saved is what a person would write by hand. The config stays the truth: the
 * page only draws and edits what is in it.
 */

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** Where each node goes on the canvas: one column per step after the prompt, the nodes of a step one under another. */
export function layout(stack: StackConfig, col = 250, row = 120): Record<string, { x: number; y: number }> {
  const ids = Object.keys(stack.nodes);
  let order: string[];
  try {
    order = stackOrder(stack);
  } catch {
    order = ids; // a circle: the page shows the problem, the nodes still need a place
  }
  const level = new Map<string, number>();
  for (const id of order) {
    const from = (stack.nodes[id]?.from ?? []).filter((f) => level.has(f));
    level.set(id, from.length ? 1 + Math.max(...from.map((f) => level.get(f)!)) : 0);
  }
  const columns = new Map<number, string[]>();
  for (const id of ids) columns.set(level.get(id) ?? 0, [...(columns.get(level.get(id) ?? 0) ?? []), id]);
  const at: Record<string, { x: number; y: number }> = {};
  // the prompt sits at x 0; the first column leaves room for it
  for (const [l, column] of columns) column.forEach((id, i) => (at[id] = { x: 150 + l * col, y: (i - (column.length - 1) / 2) * row }));
  return at;
}

/** The nodes the stack answers with; none while its shape is wrong. */
export function outputsOf(stack: StackConfig): string[] {
  try {
    return stackOutputs(stack);
  } catch {
    return [];
  }
}

/** Whether `a` gets, directly or through others, the answer of `b`. */
export function dependsOn(stack: StackConfig, a: string, b: string, seen = new Set<string>()): boolean {
  if (seen.has(a)) return false;
  seen.add(a);
  return (stack.nodes[a]?.from ?? []).some((f) => f === b || dependsOn(stack, f, b, seen));
}

/** The fields only a grounding node has. */
const GROUND_KEYS = ["sources", "mode", "query", "rules", "attach", "budget", "top", "mask"] as const;

/** A node without the fields that say nothing: the defaults, empty lists and texts, "by" when it does not choose. */
export function cleanNode(node: StackNode): StackNode {
  const n: StackNode = { ...node };
  if (n.role === "ground") {
    // a grounding node has no model and none of what a model has; its defaults are left out
    for (const k of ["model", "tools", "output", "by", "fallback", "instructions", "requirements"] as const) delete n[k];
    if (!n.from?.length) delete n.from;
    if (n.min === undefined || !n.from || n.min > n.from.length) delete n.min;
    if (n.mode === "enrich") delete n.mode;
    if (n.query === "request") delete n.query;
    if (!n.rules?.trim()) delete n.rules;
    const attach = (n.attach ?? []).map((p) => p.trim()).filter(Boolean);
    if (attach.length) n.attach = attach;
    else delete n.attach;
    if (!n.mask?.length) delete n.mask;
    for (const k of ["budget", "top"] as const) if (n[k] === undefined || Number.isNaN(n[k])) delete n[k];
    n.sources = n.sources ?? [];
    return n;
  }
  for (const k of GROUND_KEYS) delete n[k];
  if (!n.from?.length) delete n.from;
  if (!n.role || n.role === "answer") delete n.role;
  if (n.role !== "choose") delete n.by;
  if (!n.instructions?.trim()) delete n.instructions;
  if (!n.fallback?.length) delete n.fallback;
  if (!n.output) delete n.output;
  // only a node that answers writes
  if (n.tools === undefined || (n.tools === "write" && n.role)) delete n.tools;
  if (n.min === undefined || !n.from || n.min > n.from.length) delete n.min;
  // only a node that verifies has requirements of its own
  const requirements = (n.requirements ?? []).map((r) => r.trim()).filter(Boolean);
  if (n.role === "verify" && requirements.length) n.requirements = requirements;
  else delete n.requirements;
  return n;
}

function withNode(stack: StackConfig, id: string, node: StackNode): StackConfig {
  return { ...stack, nodes: { ...stack.nodes, [id]: cleanNode(node) } };
}

/** `to` gets the answer of `from`; refused when it would go round in a circle. */
export function connect(stack: StackConfig, from: string, to: string): StackConfig {
  if (!stack.nodes[from] || !stack.nodes[to]) throw new Error("both ends must be nodes");
  if (from === to) throw new Error("a node cannot get its own answer");
  if (stack.nodes[to]!.from?.includes(from)) return stack;
  if (dependsOn(stack, from, to)) throw new Error(`${from} already depends on ${to}: that would go round in a circle`);
  return withNode(stack, to, { ...stack.nodes[to]!, from: [...(stack.nodes[to]!.from ?? []), from] });
}

/** `to` stops getting the answer of `from` (with no inputs left, it gets the prompt). */
export function disconnect(stack: StackConfig, from: string, to: string): StackConfig {
  const node = stack.nodes[to];
  if (!node?.from?.includes(from)) return stack;
  return withNode(stack, to, { ...node, from: node.from.filter((f) => f !== from) });
}

/** A new node, named "node", "node2"… and set to `model`. */
export function addNode(stack: StackConfig, model: string): { stack: StackConfig; id: string } {
  let id = "node";
  for (let i = 2; stack.nodes[id]; i++) id = `node${i}`;
  return { stack: { ...stack, nodes: { ...stack.nodes, [id]: { model } } }, id };
}

/** A new grounding node, named "context", "context2"…, searching `sources`; it still has to feed a node. */
export function addGround(stack: StackConfig, sources: string[]): { stack: StackConfig; id: string } {
  let id = "context";
  for (let i = 2; stack.nodes[id]; i++) id = `context${i}`;
  return { stack: { ...stack, nodes: { ...stack.nodes, [id]: { role: "ground", sources } } }, id };
}

/** The stack without the node; the ones that got from it stop getting it. */
export function removeNode(stack: StackConfig, id: string): StackConfig {
  const nodes: Record<string, StackNode> = {};
  for (const [k, n] of Object.entries(stack.nodes)) if (k !== id) nodes[k] = n.from?.includes(id) ? cleanNode({ ...n, from: n.from.filter((f) => f !== id) }) : n;
  return { ...stack, nodes };
}

/** The node under a new name, in the same place, and the nodes that got from it follow. */
export function renameNode(stack: StackConfig, id: string, next: string): StackConfig {
  if (next === id) return stack;
  if (!NAME.test(next)) throw new Error("use letters, digits, dot, dash or underscore");
  if (stack.nodes[next]) throw new Error(`there is already a node "${next}"`);
  const nodes: Record<string, StackNode> = {};
  for (const [k, n] of Object.entries(stack.nodes)) {
    const node = n.from?.includes(id) ? { ...n, from: n.from.map((f) => (f === id ? next : f)) } : n;
    nodes[k === id ? next : k] = node;
  }
  return { ...stack, nodes };
}

/** The node with some fields changed, cleaned; a field set to undefined goes away. */
export function updateNode(stack: StackConfig, id: string, patch: Partial<StackNode>): StackConfig {
  const node = stack.nodes[id];
  if (!node) return stack;
  const merged = { ...node, ...patch } as StackNode;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (merged as unknown as Record<string, unknown>)[k];
  return withNode(stack, id, merged);
}

/** "a/b/c, d/e" → ["a/b/c", "d/e"]. */
export function parseRefs(text: string): string[] {
  return text.split(/[,\s]+/).map((r) => r.trim()).filter(Boolean);
}

/** The stack as it is saved: every node cleaned, no empty description or purpose, and only the settings for writing that say something. */
export function cleanStack(stack: StackConfig): StackConfig {
  const out: StackConfig = { nodes: Object.fromEntries(Object.entries(stack.nodes).map(([k, n]) => [k, cleanNode(n)])) };
  if (stack.description?.trim()) out.description = stack.description.trim();
  const purpose = stack.purpose?.trim();
  const write: NonNullable<StackConfig["write"]> = {};
  const run = (stack.write?.run ?? []).map((c) => c.trim()).filter(Boolean);
  if (run.length) write.run = run;
  if (stack.write?.check?.trim()) write.check = stack.write.check.trim();
  if (stack.write?.fence !== undefined) write.fence = stack.write.fence;
  return { ...(out.description && { description: out.description }), ...(purpose && { purpose }), nodes: out.nodes, ...(Object.keys(write).length && { write }) };
}
