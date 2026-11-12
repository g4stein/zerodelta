/** Best-effort instance limits, not a distributed quota or a DDoS defense. */
export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}

export function createGate(limit: number, concurrency: number, now = Date.now) {
  let windowStart = now(), count = 0, active = 0;
  return () => {
    const time = now();
    if (time - windowStart >= 60_000) { windowStart = time; count = 0; }
    if (count >= limit) throw new RequestError("Request limit reached; please retry shortly", 429, Math.max(1, Math.ceil((windowStart + 60_000 - time) / 1000)));
    if (active >= concurrency) throw new RequestError("Demo is busy; please retry shortly", 429, 5);
    count++; active++;
    let released = false;
    return () => { if (!released) { active--; released = true; } };
  };
}

/** Bound actual streamed bytes, including chunked requests with no Content-Length. */
export async function readJsonObject(req: Request, maxBytes = 4096, timeoutMs = 5000): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new RequestError("Expected application/json", 415);
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new RequestError("Request body exceeds 4096 bytes", 413);
  if (!req.body) throw new RequestError("Expected a JSON object", 400);
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestError("Request body timed out", 408)), timeoutMs);
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RequestError("Request body exceeds 4096 bytes", 413);
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
    catch { throw new RequestError("Malformed JSON", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Expected a JSON object", 400);
    return body as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    // Do not await cancellation: a malicious stream may never settle it.
    void reader.cancel().catch(() => {});
  }
}

export function requestError(err: unknown, fallback: string, fields: Record<string, unknown> = {}): Response {
  const known = err instanceof RequestError;
  return Response.json({ ...fields, error: known ? err.message : fallback }, {
    status: known ? err.status : 503,
    headers: { "cache-control": "no-store", ...(known && err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) },
  });
}

/** Coalesce concurrent polls and retain successful results for a short interval. */
export function createShortCache<T>(load: () => Promise<T>, ttlMs: number, now = Date.now) {
  let cached: { value: T; until: number } | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    if (cached && now() < cached.until) return Promise.resolve(cached.value);
    if (!pending) pending = Promise.resolve().then(load).then(value => {
      cached = { value, until: now() + ttlMs };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
