import { ProviderError } from "../types.ts";
import { sseData } from "./sse.ts";

/** Pulls a readable message out of an error body (JSON `error.message`, `message`, or the raw text). */
export function errorMessage(body: string): string {
  try {
    const json = JSON.parse(body);
    const e = Array.isArray(json) ? json[0]?.error : json.error;
    const message = (typeof e === "string" ? e : e?.message) ?? json.message;
    if (typeof message === "string" && message) return message.slice(0, 300);
  } catch {}
  return body.trim().slice(0, 300);
}

export function describeFailure(e: unknown, url: string, timeoutMs?: number): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return `timed out after ${(timeoutMs ?? 0) / 1000}s`;
    if (e.name === "AbortError") return "interrupted";
    const code = (e as { code?: string }).code;
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") return `cannot connect to ${new URL(url).origin}`;
    return e.message;
  }
  return String(e);
}

export interface StreamRequest {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** The person's Esc: the only thing that stops a model's answer (no clock does). */
  signal?: AbortSignal;
  /** Called with each SSE `data:` payload; return true to stop reading. */
  onData: (data: string) => boolean | void;
  /** Whether any text already reached the user (decides if a failure may still fall back). */
  hasText: () => boolean;
}

/**
 * POSTs a JSON body and reads the server-sent events back. Every failure becomes a ProviderError. There is no time
 * limit: a model answers for as long as it takes, until it ends or the person stops it.
 */
export async function streamSse(r: StreamRequest): Promise<void> {
  let response: Response;
  try {
    response = await fetch(r.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...r.headers },
      body: JSON.stringify(r.body),
      signal: r.signal,
    });
  } catch (e) {
    throw new ProviderError(r.provider, describeFailure(e, r.url));
  }
  if (!response.ok || !response.body) {
    const detail = errorMessage(await response.text().catch(() => ""));
    throw new ProviderError(r.provider, `HTTP ${response.status}${detail ? `: ${detail}` : ""}`, false, response.status);
  }
  try {
    for await (const data of sseData(response.body)) if (r.onData(data)) break;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(r.provider, describeFailure(e, r.url), r.hasText());
  }
}

/** GETs a JSON document (listings, metadata). Failures throw a plain Error with a readable message. */
export async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    throw new Error(describeFailure(e, url, timeoutMs));
  }
  const body = await response.text();
  if (!response.ok) {
    const detail = errorMessage(body);
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`not JSON: ${body.trim().slice(0, 120)}`);
  }
}
