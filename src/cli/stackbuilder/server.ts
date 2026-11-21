import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isMachine, stackProblems, type Core, type SourceConfig, type StackConfig, type StackEvent } from "../../core/index.ts";
import { cleanStack } from "./graph.ts";
import page from "./page/index.html";

/**
 * The /stackbuilder page and its API, on this machine only. The page draws and edits the config's stacks; saving
 * goes through the core, so the config stays the truth and a running session sees the change. Every API call carries
 * the token from the address the page was opened at, so another page in the browser cannot reach it.
 */

export interface BuilderOptions {
  /** Where kli runs: the nodes' tools read there when a stack is tested. */
  root?: string;
  /** 0 = any free port. */
  port?: number;
  /** A stack was saved (renamed from `previous`), deleted, or chosen to answer (null: the model answers). */
  onChange?: (change: { saved?: string; previous?: string; deleted?: string; active?: string | null }) => void;
}

export interface Builder {
  /** The page's address, with its token. */
  url: string;
  stop(): void;
}

/** What the page needs to start: the stacks, the one answering, and the models it can offer. */
export function builderState(core: Core, root?: string) {
  const config = core.config;
  const refs = new Set<string>();
  const sources: string[] = [];
  for (const [name, l] of Object.entries(config.locations)) {
    if (isMachine(l))
      for (const [p, provider] of Object.entries(l.providers)) {
        sources.push(`${name}/${p}`);
        const model = (provider as { model?: string }).model;
        refs.add(model ? `${name}/${p}/${model}` : `${name}/${p}`);
      }
    else {
      sources.push(name);
      const model = (l as { model?: string }).model;
      refs.add(model ? `${name}/${model}` : name);
    }
  }
  for (const ref of [config.model, ...(config.fallback ?? [])]) if (ref) refs.add(ref);
  const stacks = config.stacks ?? {};
  for (const s of Object.values(stacks)) for (const n of Object.values(s.nodes)) for (const r of [n.model, ...(n.fallback ?? [])]) if (r) refs.add(r);
  return {
    stacks,
    active: config.stack ?? null,
    model: config.model ?? null,
    refs: [...refs].sort(),
    sources,
    /** The data sources the grounding nodes search (not the ones above, where models come from). */
    dataSources: config.sources ?? {},
    problems: Object.fromEntries(Object.entries(stacks).map(([n, s]) => [n, core.stackModelProblems(s)])),
    folder: root ? root.replace(homedir(), "~") : null,
    config: core.configPath ? core.configPath.replace(homedir(), "~") : null,
  };
}

/** What the page sees of a stack event: a tool is reduced to its label and whether it worked. */
function serialize(e: StackEvent): unknown {
  if (e.type !== "tool") return e;
  return { type: "tool", node: e.node, phase: e.event.phase, label: e.event.label, ...(e.event.result && { ok: e.event.result.ok }) };
}

export function startBuilder(core: Core, options: BuilderOptions = {}): Builder {
  const token = randomUUID();
  /** Runs waiting for the person to choose: the letter, or undefined to let the next in "by" choose. */
  const waiting = new Map<string, (label: string | undefined) => void>();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const fail = (e: unknown, status = 400) => json({ error: (e as Error).message }, status);
  const state = () => builderState(core, options.root);

  // every call must come from the page: the token, and an address on this machine (a site renamed to 127.0.0.1 is not)
  const guard = (req: Request): Response | undefined => {
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") return json({ error: "this page answers on 127.0.0.1 only" }, 403);
    if (req.headers.get("x-kli-token") !== token) return json({ error: "open the address kli printed: it carries the page's key" }, 403);
  };
  const api =
    (handler: (req: Request & { params: Record<string, string> }) => Response | Promise<Response>) =>
    async (req: Request & { params: Record<string, string> }) =>
      guard(req) ?? handler(req);

  const run = async (req: Request): Promise<Response> => {
    let body: { name?: string; stack?: StackConfig; prompt?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch (e) {
      return fail(e);
    }
    const name = body.name || "draft";
    if (!body.prompt?.trim()) return fail(new Error("write a prompt to test the stack with"));
    let runner: ReturnType<Core["draftStack"]>;
    try {
      runner = core.draftStack(name, cleanStack(body.stack ?? { nodes: {} }), "builder", options.root);
    } catch (e) {
      return fail(e);
    }
    const id = randomUUID();
    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
          } catch {
            open = false;
          }
        };
        // a slow model sends nothing for a while: a tick keeps the connection from being taken as idle
        const tick = setInterval(() => send({ type: "tick" }), 5000);
        send({ type: "run", id, trace: runner.id });
        try {
          const result = await runner.send(body.prompt!, {
            signal: req.signal,
            onEvent: (e) => send(serialize(e)),
            ask: (choice) =>
              new Promise((resolve) => {
                waiting.set(id, resolve);
                choice.signal?.addEventListener("abort", () => resolve(undefined));
                send({ type: "choose", node: choice.node, options: choice.options });
              }),
          });
          send({ type: "result", result });
        } catch (e) {
          send({ type: "error", error: (e as Error).message });
        } finally {
          clearInterval(tick);
          waiting.delete(id);
          await runner.close();
          if (open) controller.close();
          open = false;
        }
      },
      cancel() {
        open = false;
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    development: false,
    // a run streams for as long as its models take; the ticks keep it alive
    idleTimeout: 60,
    routes: {
      "/": page,
      "/api/state": { GET: api(() => json(state())) },
      "/api/check": {
        POST: api(async (req) => {
          try {
            const { name, stack } = (await req.json()) as { name?: string; stack?: StackConfig };
            const s = cleanStack(stack ?? { nodes: {} });
            const shape = stackProblems(name || "draft", s);
            const named = name && !/^[a-z0-9][a-z0-9._-]*$/i.test(name) ? [`stack "${name}": use letters, digits, dot, dash or underscore`] : [];
            return json({ problems: [...named, ...shape, ...(shape.length ? [] : core.stackModelProblems(s))] });
          } catch (e) {
            return fail(e);
          }
        }),
      },
      "/api/stacks/:name": {
        PUT: api(async (req) => {
          try {
            const { stack, previous } = (await req.json()) as { stack?: StackConfig; previous?: string };
            core.saveStack(req.params.name!, cleanStack(stack ?? { nodes: {} }), previous || undefined);
            options.onChange?.({ saved: req.params.name, ...(previous && previous !== req.params.name && { previous }) });
            return json(state());
          } catch (e) {
            return fail(e);
          }
        }),
        DELETE: api((req) => {
          try {
            core.deleteStack(req.params.name!);
            options.onChange?.({ deleted: req.params.name });
            return json(state());
          } catch (e) {
            return fail(e);
          }
        }),
      },
      "/api/active": {
        PUT: api(async (req) => {
          try {
            const { name } = (await req.json()) as { name?: string | null };
            core.setStack(name || undefined);
            options.onChange?.({ active: name || null });
            return json(state());
          } catch (e) {
            return fail(e);
          }
        }),
      },
      "/api/models": {
        GET: api(async (req) => {
          const where = new URL(req.url).searchParams.get("where") ?? "";
          try {
            const models = await core.models(where, core.config, AbortSignal.timeout(20_000));
            return json({ models: models.map((m) => m.id) });
          } catch (e) {
            return fail(e, 502);
          }
        }),
      },
      "/api/sources/:name": {
        PUT: api(async (req) => {
          try {
            const { source, previous } = (await req.json()) as { source?: SourceConfig; previous?: string };
            if (!source) throw new Error("no source to save");
            core.saveSource(req.params.name!, source, previous || undefined);
            return json(state());
          } catch (e) {
            return fail(e);
          }
        }),
        DELETE: api((req) => {
          try {
            core.deleteSource(req.params.name!);
            return json(state());
          } catch (e) {
            return fail(e);
          }
        }),
      },
      // a search as a grounding node would make it, before saving: what it finds
      "/api/source-test": {
        POST: api(async (req) => {
          try {
            const { source, query } = (await req.json()) as { source?: SourceConfig; query?: string };
            if (!source) throw new Error("no source to test");
            if (!query?.trim()) throw new Error("write what to search for");
            return json(await core.testSource(source, query));
          } catch (e) {
            return fail(e);
          }
        }),
      },
      "/api/run": { POST: api(run) },
      "/api/choose": {
        POST: api(async (req) => {
          const { run: id, label } = (await req.json()) as { run?: string; label?: string | null };
          const resolve = id ? waiting.get(id) : undefined;
          if (!resolve) return json({ error: "nothing waits for a choice in that run" }, 404);
          waiting.delete(id!);
          resolve(label || undefined);
          return json({ ok: true });
        }),
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/?t=${token}`,
    stop: () => {
      for (const resolve of waiting.values()) resolve(undefined);
      server.stop(true);
    },
  };
}

/** Opens an address in the person's browser; false when there is no way to here. */
export function openInBrowser(url: string): boolean {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}
