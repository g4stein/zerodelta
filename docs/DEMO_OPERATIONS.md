# Demo operations and request safeguards

The public demo performs read-only RPC calls, dry quotes and local simulations. It has no signing credentials, does not broadcast transactions, and moves no funds.

## Implemented in the application

- `POST /api/swarm` accepts only a JSON object with `Content-Type: application/json`. Actual streamed bytes are limited to 4096, even without a Content-Length header. Reading the body has a five-second deadline.
- Invalid JSON/non-object bodies return 400, unsupported content types 415, oversized bodies 413 and stalled bodies 408. They never start the swarm pipeline.
- Each warm server instance admits at most 12 swarm starts per minute and 2 concurrent requests, including body reading. The preview endpoint admits 60 checks per minute and 6 concurrent checks. A busy/exhausted instance returns 429 with `Retry-After` before starting upstream work. These are aggregate limits shared by visitors on that instance.
- Successful telemetry snapshots are reused for ten seconds per instance and concurrent polls share one pending load. The v3.1 status reader also retains its existing 60-second cache. The preview checker continues to perform fresh view calls.
- Unexpected upstream errors return 503 with a generic message; raw upstream exception details are not reflected. Preview failures remain `live: false`.
- Responses include nosniff, frame denial, restrictive browser permission policy and referrer policy. The CSP restricts framing, objects and base URLs; it is not a complete script allowlist.

Implementation: [`requestPolicy.ts`](../src/lib/server/requestPolicy.ts), [swarm route](../src/app/api/swarm/route.ts), [preview route](../src/app/api/hedge-preview/route.ts), [`next.config.ts`](../next.config.ts). Regression tests exercise streamed-body bounds, stalled reads, quota resets, slot release, cache coalescing and rejection before upstream work.

## Deployment-wide protection is not established

Counters and caches are in process memory. A cold start, additional instance or deployment creates independent state. These safeguards reduce accidental repeat traffic and work on an individual instance; they do not enforce a global/per-visitor quota or prevent distributed denial of service. No client-supplied IP header is trusted as an identity.

Before claiming deployment-wide throttling, configure and verify a shared limiter or platform firewall rule for `/api/swarm` POST and `/api/hedge-preview` GET, with allowances for normal demo traffic. No connected Vercel administrative session or shared-store credentials were available during this pass, so this configuration is **pending**. Application tests do not prove the provider firewall is configured.

## Read-only health check

```bash
curl -fsS 'https://zerodelta.vercel.app/api/hedge-preview?scenario=size-attack' \
  | jq '{live, contractId, blockHeight, violations: .evaluation.violations}'
```

Expect `live: true`, the pinned v3.1 contract, and `ORDER_SIZE_CAP` among the violations. A 503 is unavailable, not an approval. A 429 means wait for `Retry-After`; avoid repeated refreshes. Do not use setup scripts or send a signing transaction to test uptime.

Keep hosting and RPC access available through judging (November 18; ideally November 25). Public upstream availability remains outside the repository's control.
