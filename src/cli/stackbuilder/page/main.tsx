import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { stackProblems } from "../../../core/stack.ts";
import { CHOOSERS, GROUND_MODES, GROUND_QUERIES, MASKS, NODE_ROLES, type Chooser, type GroundMode, type GroundQuery, type Mask, type NodeRole, type SourceConfig, type StackConfig, type StackNode } from "../../../core/types.ts";
import { addGround, addNode, cleanStack, connect, disconnect, layout, outputsOf, parseRefs, removeNode, renameNode, updateNode } from "../graph.ts";

/** The stack builder: draws the config's stacks as graphs, edits them, tests them with a prompt and saves them. */

// ---------- what the server sends ----------

interface State {
  stacks: Record<string, StackConfig>;
  active: string | null;
  model: string | null;
  refs: string[];
  sources: string[];
  /** The data sources the grounding nodes search. */
  dataSources: Record<string, SourceConfig>;
  problems: Record<string, string[]>;
  folder: string | null;
  config: string | null;
}
type Mark = "met" | "partial" | "missing";
interface NodeResult {
  node: string;
  role: NodeRole;
  model: string;
  answeredBy?: string;
  status: "ok" | "failed" | "skipped" | "interrupted";
  text: string;
  ms: number;
  firstTokenMs?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  costUsd?: number;
  steps: number;
  tools: { name: string; label: string; ok: boolean }[];
  error?: string;
  contributions?: Record<string, number>;
  verdict?: { requirements: string[]; judged: { node: string; items: Mark[]; adherence: number; note?: string }[] };
  choice?: { node: string; label: string; by: Chooser; why?: string; passed?: string[] };
  changes?: { files: { path: string; added: number; removed: number }[]; added: number; removed: number; patchFile?: string };
  check?: { command: string; ok: boolean; code: number | null; ms: number; output: string };
  grounding?: Grounded;
}
/** What a grounding node handed on in a test. */
interface Grounded {
  mode: GroundMode;
  items: { source: string; title: string; ref: string; link?: string; modified?: string; relevance?: number; text: string }[];
  sources: { name: string; ms: number; found: number; kept: number; error?: string }[];
  tokens: number;
  cut: number;
}
interface Excerpt {
  source: string;
  title: string;
  ref: string;
  text: string;
  relevance: number;
  modified?: string;
}
interface StackResult {
  ms: number;
  nodes: NodeResult[];
  outputs: NodeResult[];
  outputTokens?: number;
  costUsd?: number;
  nodeMs: number;
}
interface NodeRun {
  status: "running" | NodeResult["status"];
  text: string;
  model?: string;
  tool?: string;
  result?: NodeResult;
}
interface Run {
  id?: string;
  status: "running" | "done" | "stopped" | "error";
  nodes: Record<string, NodeRun>;
  result?: StackResult;
  error?: string;
  choose?: { node: string; options: { label: string; node: string; text: string }[] };
}

// ---------- talking to kli ----------

const token = new URLSearchParams(location.search).get("t") ?? "";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-kli-token": token, ...init.headers } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const ROLE_HELP: Record<NodeRole, string> = {
  answer: "answers the prompt, or joins the answers it gets",
  aggregate: "joins the answers it gets into one, and says how much came from each",
  verify: "only judges the answers it gets against the prompt (it is not an answer of the stack)",
  choose: "chooses one of the answers it gets; the chosen one becomes the answer",
  ground: "brings context from data sources to the next step (no model: it only searches); what it gets passes through",
};
const MODE_HELP: Record<GroundMode, string> = {
  enrich: "the next model uses the context when it helps, with what it knows, and cites it",
  restrict: "the next model answers only from the context, cites it, and says when it is not there",
};
const QUERY_HELP: Record<GroundQuery, string> = { request: "the prompt", answers: "the answers it gets (the facts a draft cites)", both: "the prompt and the answers" };
const CHOOSER_HELP: Record<Chooser, string> = { model: "this node's model", person: "you, on the screen", decision: "a decision model (skipped until one is trained)" };

// where the person left the nodes, kept in this browser only: the config does not store positions
function loadPositions(name: string): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(`kli-stackbuilder:${name}`) ?? "{}");
  } catch {
    return {};
  }
}
function savePositions(name: string, positions: Record<string, { x: number; y: number }>) {
  try {
    localStorage.setItem(`kli-stackbuilder:${name}`, JSON.stringify(positions));
  } catch {}
}

// ---------- the nodes on the canvas ----------

interface StepData extends Record<string, unknown> {
  node: StackNode;
  output: boolean;
  problem: boolean;
  run?: NodeRun;
  /** It waits for the person to choose, in the test panel. */
  asking?: boolean;
}

function ms(n?: number): string {
  if (n === undefined) return "";
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

function StepNode({ id, data, selected }: NodeProps<Node<StepData, "step">>) {
  const { node, output, problem, run, asking } = data;
  const role = node.role ?? "answer";
  const r = run?.result;
  if (role === "ground")
    return (
      <div className={`step ground ${selected ? "selected" : ""} ${problem ? "problem" : ""}`}>
        <Handle type="target" position={Position.Left} />
        <div className="name">
          {run && <span className={`dot ${run.status}`} />}◈ {id}
        </div>
        <div className="model">{node.sources?.length ? `searches ${node.sources.join(", ")}` : "no source yet"}</div>
        <div className="badges">
          <span className="badge ground">grounding · {node.mode ?? "enrich"}</span>
          {node.query && node.query !== "request" && <span className="badge">by the {node.query}</span>}
          {node.budget && <span className="badge">{node.budget} tokens</span>}
          {node.mask?.length ? <span className="badge">hides {node.mask.join(", ")}</span> : null}
        </div>
        {run && (
          <div className="run">
            {run.status === "running" ? (run.tool ?? "searching…") : r?.grounding ? `${r.grounding.items.length} excerpts · ${r.grounding.tokens} tokens${r.grounding.cut ? ` · ${r.grounding.cut} left out` : ""}` : r ? `${r.status}${r.error ? `: ${r.error}` : ""}` : run.status}
          </div>
        )}
        <Handle type="source" position={Position.Right} />
      </div>
    );
  return (
    <div className={`step ${role === "verify" ? "verify" : ""} ${selected ? "selected" : ""} ${problem ? "problem" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="name">
        {run && <span className={`dot ${run.status}`} />}
        {id}
      </div>
      <div className="model">{node.model || "no model"}</div>
      <div className="badges">
        {role !== "answer" && <span className="badge role">{role}{role === "choose" && node.by ? ` · ${node.by.join(" → ")}` : ""}</span>}
        {output && <span className="badge out">answer</span>}
        {node.tools === "none" && <span className="badge">no tools</span>}
        {node.tools === "write" && <span className="badge write">writes</span>}
        {node.min && <span className="badge">min {node.min}</span>}
        {node.fallback?.length ? <span className="badge">fallback {node.fallback.length}</span> : null}
        {node.instructions && <span className="badge">instructions</span>}
        {node.requirements?.length ? <span className="badge">{node.requirements.length === 1 ? "1 requirement" : `${node.requirements.length} requirements`}</span> : null}
      </div>
      {run && (
        <div className="run">
          {asking ? "waiting for you to choose ↓" : run.status === "running" ? (run.tool ? `● ${run.tool}` : run.text ? "writing…" : "waiting for the model…") : r ? `${r.status} · ${ms(r.ms)}${r.tokensPerSecond ? ` · ${r.tokensPerSecond} tok/s` : ""}` : run.status}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function PromptNode() {
  return (
    <div className="prompt-node">
      prompt
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { step: StepNode, prompt: PromptNode };

// ---------- one stack being edited ----------

interface Draft {
  /** The name it has in the editor. */
  name: string;
  stack: StackConfig;
  /** The name it is saved under; none = not saved yet. */
  saved?: string;
  positions: Record<string, { x: number; y: number }>;
}

function newDraft(names: string[], model: string): Draft {
  let name = "stack";
  for (let i = 2; names.includes(name); i++) name = `stack${i}`;
  return { name, stack: { nodes: { first: { model } } }, positions: {} };
}

function Builder() {
  const [state, setState] = useState<State>();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [modelProblems, setModelProblems] = useState<string[]>([]);
  const [found, setFound] = useState<Record<string, string[]>>({});
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<Run>();
  const stop = useRef<AbortController>(undefined);
  const flow = useReactFlow();
  const flowBox = useRef<HTMLDivElement>(null);

  const say = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast((t) => (t?.text === text ? undefined : t)), error ? 6000 : 2500);
  }, []);

  const fromState = useCallback((s: State, keep?: string) => {
    setState(s);
    const names = Object.keys(s.stacks);
    const ds: Draft[] = names.map((n) => ({ name: n, stack: structuredClone(s.stacks[n]!), saved: n, positions: loadPositions(n) }));
    if (!ds.length) ds.push(newDraft([], s.model ?? s.refs[0] ?? ""));
    setDrafts(ds);
    const at = Math.max(0, ds.findIndex((d) => d.name === (keep ?? s.active ?? names[0])));
    setCurrent(at);
    setSelected(undefined);
  }, []);

  useEffect(() => {
    api<State>("/api/state")
      .then((s) => fromState(s))
      .catch((e) => say((e as Error).message, true));
  }, [fromState, say]);

  const draft = drafts[current];
  const setDraft = useCallback((change: (d: Draft) => Draft) => setDrafts((ds) => ds.map((d, i) => (i === current ? change(d) : d))), [current]);
  // an edit that cannot be made (a circle, a name taken) says why here, before the state changes
  const edit = useCallback(
    (change: (s: StackConfig) => StackConfig) => {
      if (!draft) return;
      try {
        const next = change(draft.stack);
        setDraft((d) => ({ ...d, stack: next }));
      } catch (e) {
        say((e as Error).message, true);
      }
    },
    [draft, setDraft, say],
  );

  const dirty = (d: Draft) => !d.saved || d.saved !== d.name || JSON.stringify(cleanStack(d.stack)) !== JSON.stringify(cleanStack(state?.stacks[d.saved] ?? { nodes: {} }));
  const cleaned = useMemo(() => (draft ? cleanStack(draft.stack) : undefined), [draft]);
  const shapeProblems = useMemo(() => {
    if (!draft || !cleaned) return [];
    const named = NAME.test(draft.name) ? [] : [`stack "${draft.name}": use letters, digits, dot, dash or underscore`];
    const taken = drafts.some((d, i) => i !== current && d.name === draft.name) ? [`there is already a stack "${draft.name}"`] : [];
    return [...named, ...taken, ...stackProblems(draft.name || "draft", cleaned)];
  }, [draft, cleaned, drafts, current]);

  // the models are checked by kli (it knows the locations); the shape is checked here, as you type
  useEffect(() => {
    if (!draft || !cleaned || shapeProblems.length) return setModelProblems([]);
    const t = setTimeout(() => {
      api<{ problems: string[] }>("/api/check", { method: "POST", body: JSON.stringify({ name: draft.name, stack: cleaned }) })
        .then((r) => setModelProblems(r.problems))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [draft?.name, cleaned, shapeProblems.length]);

  const problems = [...shapeProblems, ...modelProblems];
  const outputs = useMemo(() => (cleaned ? outputsOf(cleaned) : []), [cleaned]);

  // ---------- the canvas ----------

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const auto = useMemo(() => (draft ? layout(draft.stack) : {}), [draft?.stack]);

  useEffect(() => {
    if (!draft) return;
    const problemNodes = new Set(problems.flatMap((p) => [...p.matchAll(/node "([^"]+)"/g)].map((m) => m[1]!)));
    setNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n.measured]));
      const list: Node[] = [{ id: "@prompt", type: "prompt", position: { x: 0, y: 4 }, data: {}, deletable: false, selectable: false, measured: measured.get("@prompt") }];
      for (const [id, node] of Object.entries(draft.stack.nodes))
        list.push({
          id,
          type: "step",
          position: draft.positions[id] ?? auto[id] ?? { x: 0, y: 0 },
          data: { node, output: outputs.includes(id), problem: problemNodes.has(id), run: run?.nodes[id], asking: run?.choose?.node === id } satisfies StepData,
          selected: id === selected,
          measured: measured.get(id),
        });
      return list;
    });
    setEdges((prev) => {
      const was = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      const list: Edge[] = [];
      for (const [id, node] of Object.entries(draft.stack.nodes)) {
        const judged = node.role === "verify";
        if (!node.from?.length) list.push({ id: `@prompt>${id}`, source: "@prompt", target: id, className: "prompt", deletable: false, selectable: false });
        for (const f of node.from ?? [])
          list.push({ id: `${f}>${id}`, source: f, target: id, className: judged ? "judged" : "", markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }, selected: was.has(`${f}>${id}`) });
      }
      return list;
    });
    // problems and outputs follow the stack; listing them here would only redraw more often
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, auto, run, selected, outputs.join(","), problems.join("|")]);

  // another stack on the screen, or a node added or removed: fit it all in
  const count = draft ? Object.keys(draft.stack.nodes).length : 0;
  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.15, maxZoom: 1.15 }), 60);
    return () => clearTimeout(t);
  }, [current, drafts.length, count, flow]);

  // the canvas shrinks when the test panel fills: the graph is fitted again to what is left
  useEffect(() => {
    const box = flowBox.current;
    if (!box) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const observer = new ResizeObserver(([e]) => {
      const size = `${Math.round(e!.contentRect.width)}x${Math.round(e!.contentRect.height)}`;
      if (size === last) return;
      last = size;
      clearTimeout(t);
      t = setTimeout(() => flow.fitView({ padding: 0.15, maxZoom: 1.15 }), 150);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      clearTimeout(t);
    };
  }, [flow, state === undefined]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      for (const c of changes) {
        if (c.type === "select" && c.id !== "@prompt") setSelected((s) => (c.selected ? c.id : s === c.id ? undefined : s));
        if (c.type === "position" && c.position && c.id !== "@prompt") {
          const { id, position } = c;
          setDraft((d) => {
            const positions = { ...d.positions, [id]: position };
            if (!c.dragging) savePositions(d.name, positions);
            return { ...d, positions };
          });
        }
      }
    },
    [setDraft],
  );
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), es)), []);
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === "@prompt") return;
      edit((s) => connect(s, c.source, c.target));
    },
    [edit],
  );
  const onEdgesDelete = useCallback((gone: Edge[]) => edit((s) => gone.filter((e) => e.source !== "@prompt").reduce((acc, e) => disconnect(acc, e.source, e.target), s)), [edit]);
  const onNodesDelete = useCallback(
    (gone: Node[]) => {
      edit((s) => gone.filter((n) => n.id !== "@prompt").reduce((acc, n) => removeNode(acc, n.id), s));
      setSelected(undefined);
    },
    [edit],
  );

  // ---------- saving ----------

  const save = async () => {
    if (!draft || !cleaned) return;
    try {
      const s = await api<State>(`/api/stacks/${encodeURIComponent(draft.name)}`, { method: "PUT", body: JSON.stringify({ stack: cleaned, previous: draft.saved }) });
      savePositions(draft.name, draft.positions);
      setState(s);
      setDrafts((ds) => ds.map((d, i) => (i === current ? { ...d, saved: d.name, stack: structuredClone(s.stacks[d.name]!) } : d)));
      say(`saved "${draft.name}" in the config`);
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  const revert = () => {
    if (!draft?.saved || !state) return;
    setDraft((d) => ({ ...d, name: d.saved!, stack: structuredClone(state.stacks[d.saved!]!) }));
    setSelected(undefined);
  };
  const remove = async () => {
    if (!draft) return;
    try {
      if (draft.saved) {
        const s = await api<State>(`/api/stacks/${encodeURIComponent(draft.saved)}`, { method: "DELETE" });
        setState(s);
      }
      setDrafts((ds) => {
        const left = ds.filter((_, i) => i !== current);
        return left.length ? left : [newDraft([], state?.model ?? state?.refs[0] ?? "")];
      });
      setCurrent(0);
      setSelected(undefined);
      say(draft.saved ? `deleted "${draft.saved}" from the config` : "left out the new stack");
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  const answerWith = async (name: string | null) => {
    try {
      const s = await api<State>("/api/active", { method: "PUT", body: JSON.stringify({ name }) });
      setState(s);
      say(name ? `the stack "${name}" answers in kli from now on` : "the model answers in kli from now on");
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  const create = () => {
    const d = newDraft(drafts.map((x) => x.name), state?.model ?? state?.refs[0] ?? "");
    setDrafts((ds) => [...ds, d]);
    setCurrent(drafts.length);
    setSelected("first");
  };
  const add = () => {
    if (!draft) return;
    const model = (selected && draft.stack.nodes[selected]?.model) || state?.model || state?.refs[0] || "";
    const { stack, id } = addNode(draft.stack, model);
    setDraft((d) => ({ ...d, stack }));
    setSelected(id);
  };
  const addGrounding = () => {
    if (!draft) return;
    const { stack, id } = addGround(draft.stack, Object.keys(state?.dataSources ?? {}).slice(0, 1));
    setDraft((d) => ({ ...d, stack }));
    setSelected(id);
  };
  const arrange = () => {
    if (!draft) return;
    setDraft((d) => ({ ...d, positions: {} }));
    savePositions(draft.name, {});
    setTimeout(() => flow.fitView({ padding: 0.15, maxZoom: 1.15 }), 60);
  };

  // ---------- testing ----------

  const test = async () => {
    if (!draft || !cleaned || !prompt.trim() || problems.length) return;
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    const nodesRun: Record<string, NodeRun> = {};
    setRun({ status: "running", nodes: nodesRun });
    const update = (change: (r: Run) => Run) => setRun((r) => (r ? change(r) : r));
    try {
      const r = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kli-token": token },
        body: JSON.stringify({ name: draft.name, stack: cleaned, prompt }),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line) as { type: string; node?: string; [k: string]: unknown };
          const node = e.node;
          if (e.type === "run") update((x) => ({ ...x, id: e.id as string }));
          else if (e.type === "start" && node) update((x) => ({ ...x, nodes: { ...x.nodes, [node]: { status: "running", text: "", model: e.model as string } } }));
          else if (e.type === "delta" && node) update((x) => ({ ...x, nodes: { ...x.nodes, [node]: { ...(x.nodes[node] ?? { status: "running", text: "" }), text: (x.nodes[node]?.text ?? "") + (e.text as string), tool: undefined } } }));
          else if (e.type === "tool" && node) update((x) => ({ ...x, nodes: { ...x.nodes, [node]: { ...(x.nodes[node] ?? { status: "running", text: "" }), tool: e.phase === "end" ? undefined : (e.label as string) } } }));
          else if (e.type === "doing" && node) update((x) => ({ ...x, nodes: { ...x.nodes, [node]: { ...(x.nodes[node] ?? { status: "running", text: "" }), tool: e.what as string } } }));
          else if (e.type === "choose") update((x) => ({ ...x, choose: { node: node!, options: e.options as { label: string; node: string; text: string }[] } }));
          else if (e.type === "end" && node) {
            const result = e.result as NodeResult;
            update((x) => ({ ...x, choose: x.choose?.node === node ? undefined : x.choose, nodes: { ...x.nodes, [node]: { status: result.status, text: result.text, model: result.answeredBy ?? result.model, result } } }));
          } else if (e.type === "result") update((x) => ({ ...x, status: "done", result: e.result as StackResult }));
          else if (e.type === "error") update((x) => ({ ...x, status: "error", error: e.error as string }));
        }
      }
      update((x) => (x.status === "running" ? { ...x, status: "done" } : x));
    } catch (e) {
      if (controller.signal.aborted) update((x) => ({ ...x, status: "stopped", choose: undefined }));
      else update((x) => ({ ...x, status: "error", error: (e as Error).message }));
    }
  };
  const choose = async (label: string | null) => {
    if (!run?.id) return;
    setRun((r) => (r ? { ...r, choose: undefined } : r));
    await api("/api/choose", { method: "POST", body: JSON.stringify({ run: run.id, label }) }).catch((e) => say((e as Error).message, true));
  };

  // ---------- drawing ----------

  if (!state || !draft) return <div className="empty" style={{ padding: 24 }}>{toast?.text ?? "Loading the stacks…"}</div>;
  const node = selected ? draft.stack.nodes[selected] : undefined;
  const isActive = !!draft.saved && state.active === draft.saved;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          kli <span>· stack builder</span>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!!problems.length || !dirty(draft)} onClick={save} title={problems.length ? "fix the problems first" : "write this stack to the config"}>
            Save
          </button>
          <button className="btn" disabled={!draft.saved || !dirty(draft)} onClick={revert}>
            Revert
          </button>
          {isActive ? (
            <button className="btn" onClick={() => answerWith(null)} title="the model answers in kli again">
              Stop answering with it
            </button>
          ) : (
            <button className="btn" disabled={!draft.saved || dirty(draft)} onClick={() => answerWith(draft.saved!)} title={draft.saved ? "kli answers with this stack (like /stack)" : "save it first"}>
              Answer with it
            </button>
          )}
          <button className="btn danger" onClick={remove}>
            Delete
          </button>
        </div>
        <div className="spacer" />
        <div className="meta">
          {state.active ? `answering in kli: ${state.active}` : `answering in kli: the model${state.model ? ` (${state.model})` : ""}`}
          {state.folder ? ` · nodes read in ${state.folder}` : ""}
          {state.config ? ` · ${state.config}` : ""}
        </div>
      </header>

      <div className="main">
        <aside className="side">
          <h2>Stacks</h2>
          <ul className="stack-list">
            {drafts.map((d, i) => (
              <li key={i}>
                <button
                  className={i === current ? "current" : ""}
                  onClick={() => {
                    setCurrent(i);
                    setSelected(undefined);
                  }}
                >
                  <span className={dirty(d) ? "dirty" : ""}>{d.name || "(no name)"}</span>
                  <span className={`tag ${state.active && state.active === d.saved ? "on" : ""}`}>{state.active && state.active === d.saved ? "answers" : !d.saved ? "new" : `${Object.keys(d.stack.nodes).length}`}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn small" onClick={create}>
              + New stack
            </button>
          </div>
          <p className="hint" style={{ marginTop: 16 }}>
            The config is the truth: this page draws what is in it and writes there when you save. Positions on the canvas stay in this browser.
          </p>
        </aside>

        <section className="canvas">
          {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
          <div className="flow" ref={flowBox}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onPaneClick={() => setSelected(undefined)}
            deleteKeyCode={["Backspace", "Delete"]}
            minZoom={0.3}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1.2} color="var(--dot)" />
            <Controls showInteractive={false} />
          </ReactFlow>
          </div>
          <div className="legend">drag from a node's right dot to another to pass its answer · select and press Delete to remove · dashed: judged</div>
        </section>

        <aside className="inspector">
          {problems.length ? (
            <div className="problems">
              {problems.length === 1 ? "1 problem" : `${problems.length} problems`} (it cannot be saved or tested until they are fixed)
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p.replace(/^stack "[^"]*": /, "")}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="ok-note">
              ✓ ready · {outputs.length > 1 ? `${outputs.length} answers side by side: ${outputs.join(", ")}` : `answers with ${outputs[0] ?? "—"}`}
            </div>
          )}

          {node && selected ? (
            <NodeEditor
              key={`${current}:${selected}`}
              id={selected}
              node={node}
              stack={draft.stack}
              state={state}
              found={found}
              onFound={(where, models) => setFound((f) => ({ ...f, [where]: models }))}
              say={say}
              onRename={(next) => {
                // throws when the name is taken or not valid: the editor shows it and puts the old name back
                const stack = renameNode(draft.stack, selected, next);
                setDraft((d) => {
                  const { [selected]: at, ...rest } = d.positions;
                  return { ...d, stack, positions: at ? { ...rest, [next]: at } : d.positions };
                });
                setSelected(next);
              }}
              onChange={(patch) => edit((s) => updateNode(s, selected, patch))}
              onDisconnect={(from) => edit((s) => disconnect(s, from, selected))}
              onConnect={(from) => edit((s) => connect(s, from, selected))}
              onRemove={() => {
                edit((s) => removeNode(s, selected));
                setSelected(undefined);
              }}
            />
          ) : (
            <>
              <h3>Stack</h3>
              <label className="field">
                <span>Name</span>
                <input type="text" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.trim() }))} />
                {draft.saved && draft.name !== draft.saved && <small>saving renames "{draft.saved}"{isActive ? "; kli keeps answering with it" : ""}</small>}
              </label>
              <label className="field">
                <span>Description</span>
                <input type="text" value={draft.stack.description ?? ""} placeholder="what it is for (shown in /stack)" onChange={(e) => edit((s) => ({ ...s, description: e.target.value }))} />
              </label>
              <label className="field">
                <span>Purpose</span>
                <input type="text" value={draft.stack.purpose ?? ""} placeholder="the work it takes: implementing, fixing or reviewing code" onChange={(e) => edit((s) => ({ ...s, purpose: e.target.value }))} />
                <small>with a triage model (/triage in kli), a message that asks for something else (a question, thanks, a push) goes to the model alone; blank: the stack takes every message</small>
              </label>
              {Object.values(draft.stack.nodes).some((n) => n.tools === "write") && (
                <div className="write-settings">
                  <h4>Nodes that write</h4>
                  <p className="hint">One node that writes edits your folder. Two or more compare: each works in its own copy of the folder, and in kli you apply the changes of one, or none; then every copy goes away. Leave these blank: kli takes them from the project (its .kli/write.json, or its files: bun.lock, package-lock.json, go.mod, Cargo.toml…). Fill them only for a stack made for one project.</p>
                  <label className="field">
                    <span>Commands allowed</span>
                    <input type="text" value={(draft.stack.write?.run ?? []).join(", ")} placeholder="blank: the project's test commands" onChange={(e) => edit((s) => ({ ...s, write: { ...s.write, run: e.target.value.split(",").map((c) => c.trimStart()) } }))} />
                    <small>besides the ones that only read; each allows the commands that start with it</small>
                  </label>
                  <label className="field">
                    <span>Check</span>
                    <input type="text" value={draft.stack.write?.check ?? ""} placeholder="blank: the project's tests" onChange={(e) => edit((s) => ({ ...s, write: { ...s.write, check: e.target.value } }))} />
                    <small>passed or failed goes to the results, and a verifier counts it</small>
                  </label>
                  <label className="field">
                    <span>Fence</span>
                    <select
                      value={draft.stack.write?.fence === false ? "off" : draft.stack.write?.fence?.network ? "network" : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        edit((s) => {
                          const had = s.write?.fence || {};
                          const fence = v === "off" ? false : v === "network" ? { ...had, network: true } : had.write?.length ? { write: had.write } : undefined;
                          const { fence: _, ...rest } = s.write ?? {};
                          return { ...s, write: { ...rest, ...(fence !== undefined && { fence }) } };
                        });
                      }}
                    >
                      <option value="">on: writes only in its copy, no network (default)</option>
                      <option value="network">on, with the network</option>
                      <option value="off">off</option>
                    </select>
                    <small>the nodes' commands and the check run in the system's box (sandbox-exec on macOS, bwrap on Linux); a CLI uses its own permissions</small>
                  </label>
                </div>
              )}
              <SourcesPanel state={state} setState={setState} say={say} />
              <div className="row" style={{ marginBottom: 12 }}>
                <button className="btn" onClick={add}>
                  + Add node
                </button>
                <button className="btn" onClick={addGrounding} title="a node that brings context from data sources to the next step">
                  + Add grounding
                </button>
                <button className="btn" onClick={arrange} title="put the nodes back in columns, step by step">
                  Arrange
                </button>
              </div>
              <p className="hint">
                {count === 1 ? "1 node" : `${count} nodes`}. The nodes with no inputs get the prompt and run at the same time; a node runs when the ones it gets from have answered. Click a node to edit it.
              </p>
            </>
          )}
        </aside>
      </div>

      <TestPanel draft={draft} problems={problems} outputs={outputs} prompt={prompt} setPrompt={setPrompt} run={run} onRun={test} onStop={() => stop.current?.abort()} onChoose={choose} />
    </div>
  );
}

// ---------- a grounding node ----------

/** What a grounding node searches and how it hands the context on. */
function GroundFields(props: { node: StackNode; state: State; onChange: (patch: Partial<StackNode>) => void }) {
  const { node, state } = props;
  const names = Object.keys(state.dataSources);
  const chosen = node.sources ?? [];
  const [attach, setAttach] = useState((node.attach ?? []).join("\n"));
  const mode = node.mode ?? "enrich";
  const query = node.query ?? "request";
  return (
    <>
      <div className="field">
        <span>Searches</span>
        {names.length ? (
          <div className="checks">
            {names.map((n) => (
              <label key={n} title={state.dataSources[n]!.paths.join(", ")}>
                <input type="checkbox" checked={chosen.includes(n)} onChange={(e) => props.onChange({ sources: e.target.checked ? [...chosen, n] : chosen.filter((x) => x !== n) })} />
                {n}
              </label>
            ))}
          </div>
        ) : (
          <small>no data source yet: add one in the stack's panel (click the canvas)</small>
        )}
        {chosen.filter((c) => !names.includes(c)).map((c) => (
          <small key={c} className="mark-missing">
            "{c}" is not one of the config's sources
          </small>
        ))}
      </div>
      <label className="field">
        <span>Mode</span>
        <select value={mode} onChange={(e) => props.onChange({ mode: e.target.value as GroundMode })}>
          {GROUND_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <small>{MODE_HELP[mode]}</small>
      </label>
      <label className="field">
        <span>Searches with</span>
        <select value={query} onChange={(e) => props.onChange({ query: e.target.value as GroundQuery })}>
          {GROUND_QUERIES.map((q) => (
            <option key={q} value={q} disabled={q !== "request" && !node.from?.length}>
              {QUERY_HELP[q]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Rules</span>
        <textarea value={node.rules ?? ""} placeholder="over the mode's: answer in one paragraph, cite the file…" onChange={(e) => props.onChange({ rules: e.target.value })} />
      </label>
      <label className="field">
        <span>Always attached</span>
        <textarea
          className="mono"
          value={attach}
          placeholder={"files that always go in whole, one per line:\n~/docs/glossary.md"}
          onChange={(e) => setAttach(e.target.value)}
          onBlur={() => {
            const list = attach.split("\n").map((a) => a.trim()).filter(Boolean);
            props.onChange({ attach: list.length ? list : undefined });
          }}
        />
      </label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Budget</span>
          <input type="number" min={100} step={100} value={node.budget ?? ""} placeholder="2000" onChange={(e) => props.onChange({ budget: e.target.value ? Number(e.target.value) : undefined })} />
          <small>most tokens of context</small>
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Top</span>
          <input type="number" min={1} value={node.top ?? ""} placeholder="8" onChange={(e) => props.onChange({ top: e.target.value ? Number(e.target.value) : undefined })} />
          <small>excerpts per source</small>
        </label>
      </div>
      <div className="field">
        <span>Hides</span>
        <div className="checks">
          {MASKS.map((m) => (
            <label key={m}>
              <input type="checkbox" checked={!!node.mask?.includes(m)} onChange={(e) => props.onChange({ mask: e.target.checked ? [...(node.mask ?? []), m] : (node.mask ?? []).filter((x) => x !== m) })} />
              {m}
            </label>
          ))}
        </div>
        <small>replaced in the excerpts before they reach a model</small>
      </div>
    </>
  );
}

/** The config's data sources: add a folder, change one, take one out, and try a search before using it. */
function SourcesPanel(props: { state: State; setState: (s: State) => void; say: (text: string, error?: boolean) => void }) {
  const { state } = props;
  const [editing, setEditing] = useState<{ name: string; paths: string; previous?: string }>();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ excerpts: Excerpt[]; ms: number }>();
  const [busy, setBusy] = useState(false);
  const source = (paths: string): SourceConfig => ({ type: "files", paths: paths.split("\n").map((p) => p.trim()).filter(Boolean) });
  const save = async () => {
    if (!editing) return;
    try {
      const s = await api<State>(`/api/sources/${encodeURIComponent(editing.name)}`, { method: "PUT", body: JSON.stringify({ source: source(editing.paths), previous: editing.previous }) });
      props.setState(s);
      props.say(`saved the source "${editing.name}" to the config`);
      setEditing(undefined);
      setFound(undefined);
    } catch (e) {
      props.say((e as Error).message, true);
    }
  };
  const remove = async (name: string) => {
    try {
      props.setState(await api<State>(`/api/sources/${encodeURIComponent(name)}`, { method: "DELETE" }));
      props.say(`took the source "${name}" out of the config`);
    } catch (e) {
      props.say((e as Error).message, true);
    }
  };
  const test = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      setFound(await api<{ excerpts: Excerpt[]; ms: number }>("/api/source-test", { method: "POST", body: JSON.stringify({ source: source(editing.paths), query }) }));
    } catch (e) {
      props.say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="write-settings">
      <h4>Data sources</h4>
      <p className="hint">What the grounding nodes of any stack search. For now, folders and files: Markdown, text, CSV, JSON.</p>
      {Object.entries(state.dataSources).map(([name, s]) => (
        <div key={name} className="source-row">
          <b>{name}</b> <span className="mono hint">{s.paths.join(", ")}</span>
          <div className="row">
            <button className="btn small" onClick={() => (setEditing({ name, paths: s.paths.join("\n"), previous: name }), setFound(undefined))}>
              Edit
            </button>
            <button className="btn small danger" onClick={() => remove(name)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {editing ? (
        <div className="source-form">
          <label className="field">
            <span>Name</span>
            <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Folders, files or globs</span>
            <textarea className="mono" value={editing.paths} placeholder={"one per line:\n~/docs\n~/notes/**/*.md"} onChange={(e) => setEditing({ ...editing, paths: e.target.value })} />
          </label>
          <label className="field">
            <span>Test a search</span>
            <input type="text" value={query} placeholder="what a prompt would ask" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && test()} />
          </label>
          <div className="row">
            <button className="btn" disabled={busy || !query.trim()} onClick={test}>
              {busy ? "searching…" : "Test source"}
            </button>
            <button className="btn primary" disabled={!NAME.test(editing.name)} onClick={save}>
              Save source
            </button>
            <button className="btn" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
          </div>
          {found && (
            <div className="excerpts">
              <small>
                {found.excerpts.length} excerpt{found.excerpts.length === 1 ? "" : "s"} in {ms(found.ms)}
              </small>
              {found.excerpts.map((x, i) => (
                <details key={i}>
                  <summary>
                    <span className="mono">{x.ref}</span> · {x.relevance.toFixed(2)}
                  </summary>
                  <pre>{x.text}</pre>
                </details>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button className="btn small" onClick={() => setEditing({ name: Object.keys(state.dataSources).length ? `docs${Object.keys(state.dataSources).length + 1}` : "docs", paths: "" })}>
          + Add a source
        </button>
      )}
    </div>
  );
}

/** What each grounding node handed on in a test: from which sources, each excerpt with its score, the tokens, what was cut. */
function Injected(props: { results: NodeResult[] }) {
  const grounded = props.results.filter((r) => r.grounding);
  if (!grounded.length) return null;
  return (
    <>
      {grounded.map((r) => (
        <div key={r.node} className="injected">
          <b>◈ {r.node}</b>{" "}
          <span className="hint">
            {r.grounding!.mode} · {r.grounding!.items.length} excerpts · {r.grounding!.tokens} tokens{r.grounding!.cut ? ` · ${r.grounding!.cut} left out by the budget` : ""} ·{" "}
            {r.grounding!.sources.map((s) => `${s.name} ${s.error ? `✕ ${s.error}` : `${s.kept} of ${s.found}`} (${ms(s.ms)})`).join(" · ")}
          </span>
          {r.grounding!.items.map((x, i) => (
            <details key={i}>
              <summary>
                [{i + 1}] {x.source} · <span className="mono">{x.ref}</span>
                {x.relevance !== undefined ? ` · ${x.relevance.toFixed(2)}` : ""}
              </summary>
              <pre>{x.text}</pre>
            </details>
          ))}
        </div>
      ))}
    </>
  );
}

// ---------- editing one node ----------

function NodeEditor(props: {
  id: string;
  node: StackNode;
  stack: StackConfig;
  state: State;
  found: Record<string, string[]>;
  onFound: (where: string, models: string[]) => void;
  say: (text: string, error?: boolean) => void;
  onRename: (next: string) => void;
  onChange: (patch: Partial<StackNode>) => void;
  onDisconnect: (from: string) => void;
  onConnect: (from: string) => void;
  onRemove: () => void;
}) {
  const { id, node, stack, state, found } = props;
  const [name, setName] = useState(id);
  const [fallback, setFallback] = useState((node.fallback ?? []).join(", "));
  const [requirements, setRequirements] = useState((node.requirements ?? []).join("\n"));
  const [listing, setListing] = useState(false);
  const role = node.role ?? "answer";
  const from = node.from ?? [];
  const others = Object.keys(stack.nodes).filter((n) => n !== id && !from.includes(n));
  const model = node.model ?? "";
  const source = state.sources.find((s) => model === s || model.startsWith(`${s}/`)) ?? model.split("/").slice(0, 2).join("/");
  const options = [...new Set([...state.refs, ...Object.values(found).flatMap((list) => list)])];

  const rename = () => {
    if (name === id) return;
    try {
      props.onRename(name);
    } catch (e) {
      props.say((e as Error).message, true);
      setName(id);
    }
  };
  const list = async () => {
    setListing(true);
    try {
      const r = await api<{ models: string[] }>(`/api/models?where=${encodeURIComponent(source)}`);
      props.onFound(source, r.models.map((m) => `${source}/${m}`));
      props.say(`${r.models.length} models in ${source}`);
    } catch (e) {
      props.say((e as Error).message, true);
    } finally {
      setListing(false);
    }
  };
  const by = node.by ?? ["model"];

  return (
    <>
      <h3>Node</h3>
      <label className="field">
        <span>Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value.trim())} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && rename()} />
      </label>
      {role !== "ground" && (
      <label className="field">
        <span>Model</span>
        <input type="text" className="mono" list="kli-models" value={node.model ?? ""} onChange={(e) => props.onChange({ model: e.target.value.trim() })} placeholder="location/provider/model" />
        <datalist id="kli-models">
          {options.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <div className="row">
          <button className="btn small" disabled={listing || !source} onClick={list} title="ask the provider which models it has">
            {listing ? "listing…" : `List the models of ${source || "…"}`}
          </button>
        </div>
      </label>
      )}
      <label className="field">
        <span>Role</span>
        <select
          value={role}
          onChange={(e) => {
            const next = e.target.value as NodeRole;
            // a grounding node has no model; leaving that role, the node needs one again
            props.onChange({
              role: next,
              ...(next === "choose" && !node.by && { by: ["model"] as Chooser[] }),
              ...(next === "ground" ? { model: undefined, sources: node.sources ?? Object.keys(state.dataSources).slice(0, 1) } : role === "ground" && { model: state.model ?? state.refs[0] ?? "" }),
            });
          }}
        >
          {NODE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <small>{ROLE_HELP[role]}</small>
      </label>
      {role === "ground" && <GroundFields node={node} state={state} onChange={props.onChange} />}
      {role === "choose" && (
        <div className="field">
          <span>Who chooses, in this order</span>
          <div className="checks">
            {CHOOSERS.map((c) => (
              <label key={c} title={CHOOSER_HELP[c]}>
                <input
                  type="checkbox"
                  checked={by.includes(c)}
                  onChange={(e) => {
                    const next = e.target.checked ? CHOOSERS.filter((x) => x === c || by.includes(x)) : by.filter((x) => x !== c);
                    props.onChange({ by: next.length ? next : undefined });
                  }}
                />
                {c}
              </label>
            ))}
          </div>
          <small>each one that does not choose passes to the next: {by.map((c) => CHOOSER_HELP[c]).join(" → ")}</small>
        </div>
      )}
      <div className="field">
        <span>Gets the answers of</span>
        {from.length ? (
          <div className="chips">
            {from.map((f, i) => (
              <span key={f} className="chip">
                <span className="mono">{String.fromCharCode(65 + i)}</span> {f}
                <button onClick={() => props.onDisconnect(f)} title="stop getting it">
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <small>nothing: it gets the prompt</small>
        )}
        {others.length > 0 && (
          <select value="" onChange={(e) => e.target.value && props.onConnect(e.target.value)}>
            <option value="">+ get the answer of…</option>
            {others.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )}
        {from.length > 0 && <small>it sees them by letter, without the model's name</small>}
      </div>
      {/* a step that answers runs whatever its inputs did (a stack does not stop); a judge or a chooser waits for some */}
      {from.length > 1 && (role === "verify" || role === "choose") && (
        <label className="field">
          <span>Runs when at least</span>
          <input type="number" min={1} max={from.length} value={node.min ?? 1} onChange={(e) => props.onChange({ min: Number(e.target.value) > 1 ? Number(e.target.value) : undefined })} />
          <small>of the {from.length} it gets from have answered</small>
        </label>
      )}
      {role !== "ground" && (
      <label className="field">
        <span>Tools</span>
        <select value={node.tools ?? ""} onChange={(e) => props.onChange({ tools: (e.target.value || undefined) as StackNode["tools"] })}>
          <option value="">default ({role === "answer" ? "read" : "none"})</option>
          <option value="read">read (the files where kli runs)</option>
          {role === "answer" && <option value="write">write (in its own copy of the folder)</option>}
          <option value="none">none</option>
        </select>
      </label>
      )}
      {role !== "verify" && role !== "ground" && (
        <div className="field checks">
          <label>
            <input type="checkbox" checked={!!node.output} onChange={(e) => props.onChange({ output: e.target.checked || undefined })} />
            an answer of the stack
          </label>
          <small>without any marked, the answers are the nodes no other node gets from</small>
        </div>
      )}
      {role !== "ground" && (
      <label className="field">
        <span>Fallback</span>
        <input type="text" className="mono" value={fallback} placeholder="other models, in order" onChange={(e) => setFallback(e.target.value)} onBlur={() => props.onChange({ fallback: parseRefs(fallback).length ? parseRefs(fallback) : undefined })} />
        <small>only this node's: the config's fallback never answers in a stack</small>
      </label>
      )}
      {role === "verify" && (
        <label className="field">
          <span>Requirements judged every time</span>
          <textarea
            value={requirements}
            placeholder={"one per line, such as:\ncites the file it changed"}
            onChange={(e) => setRequirements(e.target.value)}
            onBlur={() => {
              const list = requirements.split("\n").map((r) => r.trim()).filter(Boolean);
              props.onChange({ requirements: list.length ? list : undefined });
            }}
          />
          <small>besides the ones it reads in the prompt; each answer is marked on these first</small>
        </label>
      )}
      {role !== "ground" && (
      <label className="field">
        <span>Instructions</span>
        <textarea
          value={node.instructions ?? ""}
          placeholder={role === "verify" || role === "choose" ? "this node's own: the config's instructions are for answering, and do not reach a node that judges or chooses" : "added to the config's instructions for this node"}
          onChange={(e) => props.onChange({ instructions: e.target.value })}
        />
      </label>
      )}
      <button className="btn danger" onClick={props.onRemove}>
        Remove node
      </button>
    </>
  );
}

// ---------- testing the stack ----------

function TestPanel(props: { draft: Draft; problems: string[]; outputs: string[]; prompt: string; setPrompt: (p: string) => void; run?: Run; onRun: () => void; onStop: () => void; onChoose: (label: string | null) => void }) {
  const { run, outputs } = props;
  const running = run?.status === "running";
  const results = run?.result?.nodes ?? Object.values(run?.nodes ?? {}).flatMap((n) => (n.result ? [n.result] : []));
  const verdicts = results.filter((r) => r.verdict);
  const shown = run?.result ? run.result.outputs.map((o) => o.node) : outputs;
  return (
    <section className="test">
      <div className="prompt">
        <textarea
          value={props.prompt}
          placeholder="A prompt to test this stack with (it runs as it is on the screen, saved or not) · Ctrl+Enter"
          onChange={(e) => props.setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) props.onRun();
          }}
        />
        {running ? (
          <button className="btn" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button className="btn primary" disabled={!props.prompt.trim() || !!props.problems.length} onClick={props.onRun}>
            Test
          </button>
        )}
      </div>

      {run?.error && <div className="problems" style={{ marginTop: 10 }}>{run.error}</div>}

      {run?.choose && (
        <div className="choose-box">
          <strong>{run.choose.node}</strong> asks you to choose: it becomes the stack's answer
          <div className="options">
            {run.choose.options.map((o) => (
              <div key={o.label} className="answer">
                <header>
                  <b>{o.label}</b> · {o.node}
                  <span className="spacer" />
                  <button className="btn small primary" onClick={() => props.onChoose(o.label)}>
                    Choose {o.label}
                  </button>
                </header>
                <pre>{o.text}</pre>
              </div>
            ))}
          </div>
          <button className="btn small" onClick={() => props.onChoose(null)}>
            Let the next in "by" choose
          </button>
        </div>
      )}

      {run && (
        <div className="outputs">
          {shown.map((id) => {
            const n = run.nodes[id];
            const r = n?.result;
            return (
              <div key={id} className={`answer ${r && r.status !== "ok" ? "cut" : ""}`}>
                <header>
                  <span className={`dot ${n?.status ?? ""}`} />
                  <b>{id}</b> · <span className="mono">{n?.model ?? props.draft.stack.nodes[id]?.model}</span>
                  {r && <> · {ms(r.ms)}</>}
                </header>
                <pre>{n?.text || (r?.error ? r.error : n ? "…" : "waiting")}</pre>
              </div>
            );
          })}
        </div>
      )}

      {run?.result && (
        <>
          <table className="measures">
            <thead>
              <tr>
                <th>node</th>
                <th>model</th>
                <th>status</th>
                <th className="num">time</th>
                <th className="num">first text</th>
                <th className="num">tokens</th>
                <th className="num">tok/s</th>
                <th className="num">tools</th>
                <th>notes</th>
              </tr>
            </thead>
            <tbody>
              {run.result.nodes.map((r) => (
                <tr key={r.node}>
                  <td>{r.node}</td>
                  <td className="mono">{r.answeredBy && r.answeredBy !== r.model ? `${r.answeredBy} (fallback)` : r.model}</td>
                  <td className={r.status === "ok" ? "mark-met" : "mark-missing"}>{r.status}</td>
                  <td className="num">{ms(r.ms)}</td>
                  <td className="num">{ms(r.firstTokenMs)}</td>
                  <td className="num">{r.outputTokens ?? ""}</td>
                  <td className="num">{r.tokensPerSecond ?? ""}</td>
                  <td className="num">{r.tools.length || ""}</td>
                  <td>
                    {r.error ??
                      (r.grounding ? `${r.grounding.items.length} excerpts · ${r.grounding.tokens} tokens${r.grounding.cut ? ` · ${r.grounding.cut} left out` : ""}` : "") +
                      (r.changes ? `${r.changes.files.length ? `${r.changes.files.length} file${r.changes.files.length === 1 ? "" : "s"} +${r.changes.added} −${r.changes.removed}` : "no file changed"}${r.check ? ` · check ${r.check.ok ? "passed" : "failed"}` : ""} · ` : "") +
                      (r.contributions ? `from ${Object.entries(r.contributions).map(([k, v]) => `${k} ${v}%`).join(" · ")}` : "") +
                        (r.choice ? `chose ${r.choice.node} (${r.choice.by})${r.choice.why ? `: ${r.choice.why}` : ""}${r.choice.passed?.length ? ` · passed: ${r.choice.passed.join("; ")}` : ""}` : "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="summary">
            {ms(run.result.ms)} from the prompt to the last node · {ms(run.result.nodeMs)} if they had run one after another
            {run.result.outputTokens ? ` · ${run.result.outputTokens} tokens out` : ""}
            {run.result.costUsd ? ` · US$ ${run.result.costUsd.toFixed(4)}` : ""}
          </div>
        </>
      )}

      <Injected results={results} />

      {verdicts.map((v) => (
        <table key={v.node} className="measures">
          <thead>
            <tr>
              <th>{v.node} judged</th>
              {v.verdict!.judged.map((j) => (
                <th key={j.node}>{j.node}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.verdict!.requirements.map((req, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: "normal" }}>{req}</td>
                {v.verdict!.judged.map((j) => (
                  <td key={j.node} className={`mark-${j.items[i]}`}>
                    {j.items[i] === "met" ? "✓" : j.items[i] === "partial" ? "~" : "✕"}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td>
                <b>adherence</b>
              </td>
              {v.verdict!.judged.map((j) => (
                <td key={j.node}>
                  <b>{j.adherence}%</b>
                  {j.note ? <div className="hint" style={{ whiteSpace: "normal" }}>{j.note}</div> : null}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      ))}

      {!run && <div className="empty">Write a prompt and press Test: the nodes light up on the canvas as they work, and the answers come here with their measures.</div>}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReactFlowProvider>
      <Builder />
    </ReactFlowProvider>
  </StrictMode>,
);
