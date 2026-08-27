/**
 * A non-2xx from the hub, carrying the parsed body. The body is where the hub
 * says which field was invalid or which lane a registration collided with, and
 * a caller that has to re-explain the failure to an agent needs that detail
 * rather than the status alone.
 *
 * The message stays `hub returned HTTP <status>` because `scripts/bridge.ts`
 * only ever reads `.message`, and its denial reasons are asserted on.
 */
export class HubError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
    this.name = "HubError";
  }
}

export function url(path: string) {
  const hubUrl = process.env.HUB_URL ?? "http://127.0.0.1:8787";
  return new URL(path, hubUrl.endsWith("/") ? hubUrl : `${hubUrl}/`);
}

export async function hubJson(path: string, init?: RequestInit, timeout = 2_000): Promise<unknown> {
  const response = await fetch(url(path), { ...init, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A hub error is not always JSON: a route that never ran returns the
      // framework's own plain-text 404.
    }
    throw new HubError(response.status, body, `hub returned HTTP ${response.status}`);
  }
  return await response.json();
}
