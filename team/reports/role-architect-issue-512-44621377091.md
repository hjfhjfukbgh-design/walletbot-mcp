# Corrected ADR — Companion conversation concurrency and durable history

**Date:** 2026-11-20  
**Status:** Architecture recommendation only; no production code or deployment in this ADR.  
**Scope:** Prevent lost updates, preserve per-conversation message order, make retries idempotent, and keep tenant data isolated.

## Executive decision

Move **conversation history and request coordination** from a read-modify-write KV blob to **one SQLite-backed Durable Object per (Telegram tenant, conversation)**. Keep the existing global `COMPANION_QUOTA` object responsible only for quota accounting. Keep KV as a lightweight, eventually consistent conversation-list index during migration; it must no longer be the source of truth for messages or a lock.

Use a durable per-conversation FIFO queue with:
- client-supplied `requestId`, unique within the tenant/conversation;
- monotonically allocated sequence numbers;
- an atomic SQLite claim with lease expiry and a fencing token;
- Gemini I/O outside all SQL transactions;
- an atomic finalize transaction that stores the assistant reply and marks the request complete;
- replay of a completed `requestId` without another Gemini call;
- an explicit `provider_outcome_unknown` state when a crash occurs after a provider call may have been accepted but before its response is durably stored.

Do **not** use a JavaScript mutex, Promise chain, KV lock, or `blockConcurrencyWhile` around the Gemini request as the correctness mechanism.

## 1. Current implementation — repository evidence

### 1.1 Conversation history is one KV value per conversation

- `src/companion.ts:8-15` defines the 20-message storage cap and 8-message context window.
- `src/companion.ts:114-128` loads one conversation JSON value from `scoped.STATE`, then constructs the prompt context from its last messages.
- `src/companion.ts:180-200` performs the external Gemini `generateContent` request.
- `src/companion.ts:232-241` appends the user/assistant messages and writes the whole conversation value back with `scoped.STATE.put`.
- `src/tenants.ts:13-45` scopes KV keys with the authenticated Telegram user ID (the `tenant:${userId}:` prefix). This is useful tenant isolation for KV keys, but it does not make a multi-step read/fetch/write atomic.
- `src/index.ts:31` routes Companion API requests to `handleCompanionApi`.
- `miniapp/web/kripto-guru-ui.js:871-882` has a `companionBusy` flag around the current UI send action. This prevents a second send from that UI instance while it is busy; it does not coordinate another tab, device, Worker invocation, or a retry after a network timeout.
- `test/companion.test.ts:547-580` tests concurrent quota reservations. The suite does not currently exercise two simultaneous chat writes to the same conversation.

### 1.2 Why the current flow can lose messages

Two requests for the same conversation can interleave:

1. Request A reads history H.
2. Request B reads the same history H.
3. A calls Gemini with H + message A.
4. B calls Gemini with H + message B.
5. A writes H + A + answer A.
6. B writes H + B + answer B.

The final KV value can lose A and its answer. Both model calls may also be generated from stale context that excludes the other request. The same race exists if two tabs or devices send messages; the browser busy flag is not a server-side lock.

### 1.3 Existing Durable Object is a quota coordinator, not a conversation store

- `wrangler.toml:5-18` binds the existing `TradingEngine` and `CompanionQuota` SQLite Durable Object classes.
- `src/companion.ts:139-150` sends quota reservations to `COMPANION_QUOTA.idFromName("global")`.
- `src/companion-quota.ts:1-110` implements quota accounting in that object.

That single global object is intentionally shared for project-wide quota counters. Repurposing it to store all conversations would create a global serialization hotspot and mix unrelated tenant histories in one coordination boundary. Keep its current responsibility narrow.

## 2. Cloudflare concurrency facts — corrections to the earlier draft

The earlier ADR's statement that a Durable Object automatically serializes an entire async request from start to finish is **incorrect**.

1. A Durable Object runs JavaScript in a single-threaded event loop, but asynchronous handlers can interleave when one awaits network I/O. Cloudflare's **input gates** protect storage operations and synchronous execution; they do not hold a lock across an arbitrary Gemini `fetch()`. See [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
2. `blockConcurrencyWhile()` can block other events while its callback runs, but Cloudflare documents a 30-second limit; exceeding it resets the object. It is intended for bounded initialization/coordination, not as a lock around every model call. See [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/).
3. SQLite transactions make database changes atomic. They cannot include the external Gemini network operation as part of the same transaction. Persist state before and after the network call; never hold a transaction open across the provider request. See [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
4. `ctx.waitUntil()` can keep a Durable Object alive while pending work completes, for up to 15 minutes. It is useful for finishing work after a client disconnect, but it is not a durable queue and does not replace persisted request state. See [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
5. Alarms are **at-least-once**: a failed alarm can be retried (up to six automatic retries). Alarm handlers must be idempotent; an alarm firing is not proof that an external provider call happened exactly once. See [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
6. Workers KV is eventually consistent. Concurrent writes to the same key can overwrite one another; writes can take up to 60 seconds to become visible elsewhere, and the same key is limited to one write per second. KV is appropriate for a list/index cache, not for authoritative read-modify-write conversation history or distributed locking. See [KV write behavior](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) and [KV limits](https://developers.cloudflare.com/kv/platform/limits/).

## 3. Recommended ownership boundary

### 3.1 One object per tenant and conversation

Create a new SQLite-backed class, e.g. `CompanionConversation`, with a stable object name derived from both authenticated tenant and conversation ID:

```ts
const name = `tenant:${telegramUserId}:conversation:${conversationId}`;
const id = env.COMPANION_CONVERSATIONS.idFromName(name);
const stub = env.COMPANION_CONVERSATIONS.get(id);
```

The `telegramUserId` must come from validated Telegram initData, never from a caller-supplied JSON field. The DO must also validate the tenant ID passed by the Worker against its expected object identity. The composite name ensures that even if two users happen to submit the same conversation UUID, they cannot address the same object.

This gives each conversation its own ordering boundary. Different conversations can process independently; two devices working in the same conversation converge on the same DO.

### 3.2 SQLite schema

Initial schema proposal (field names can be adjusted during implementation):

```sql
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  migration_state TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  sources_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, sequence)
);

CREATE TABLE IF NOT EXISTS conversation_requests (
  conversation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  user_content TEXT NOT NULL,
  attachments_json TEXT,
  response_json TEXT,
  error_code TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  provider_call_started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, request_id),
  UNIQUE(conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS conversation_requests_queue
  ON conversation_requests(conversation_id, state, sequence);
```

The DO owns these rows. KV is not consulted to decide which message is next or whether a request has already been processed.

## 4. Request lifecycle and ordering

### 4.1 Enqueue — short atomic transaction

For every logical user message, the client supplies a stable UUID `requestId` and reuses it on retries.

Inside one SQLite transaction:
1. Verify the conversation belongs to the authenticated tenant.
2. If `(conversation_id, request_id)` already exists, return its current status/result. Do not append another user message.
3. Allocate `sequence = next_sequence`, increment `next_sequence`.
4. Insert a `queued` request with the user content and attachment metadata.
5. Commit.

The sequence number defines server acceptance order. It cannot guarantee the physical order of taps across devices when network arrival order differs.

### 4.2 Claim — short atomic transaction

A queue processor selects the earliest unfinished request for that conversation. In a transaction it:
- verifies no earlier sequence is unfinished;
- claims the row and sets `state='processing'`;
- increments `fencing_token`;
- sets a bounded lease (initial proposal: 60–90 seconds, tuned to the provider timeout);
- records the claim token and commit time.

Only one active claim exists for the conversation. A later request remains queued until the earlier request is finalized or explicitly moved to a terminal state.

### 4.3 Gemini call — outside the transaction

Build the prompt from the last eight **completed** messages plus the current queued user message. Apply the existing 4,000-character input cap, 20-message storage cap, output-token cap, separate research quota, and tenant-scoped data rules.

Then call Gemini outside SQLite transaction scope. Do not use `blockConcurrencyWhile` for this network call. A per-conversation DO queue, not an in-memory mutex, is the serialization mechanism.

### 4.4 Finalize — short atomic transaction with fencing

On a valid Gemini response, start a new transaction and update only if the stored fencing token still equals the token held by this processor:

- append the user message and assistant reply with the request's sequence/order;
- store sources/metadata with the assistant response;
- mark the request `completed` and persist the exact response payload;
- update conversation `updated_at` and message count;
- commit.

If the fencing token no longer matches, the processor is stale and must not write. This prevents a delayed old worker from overwriting the result of a newer lease holder.

### 4.5 Retry and crash semantics — do not promise exactly-once Gemini calls

A completed `requestId` returns the stored response and does not consume quota or call Gemini again. An in-progress `requestId` returns a stable `202/in_progress` status (or equivalent) for polling.

There is an unavoidable ambiguity if the Worker/DO is interrupted after Gemini accepted the request but before the response was committed to SQLite. Unless the Gemini endpoint provides a documented idempotency key for this operation (not established in this ADR), the application cannot atomically commit both the provider call and local database row.

Recommended safe handling:
- If a request was only queued/claimed and `provider_call_started_at` is null, an expired lease can be reclaimed automatically.
- If `provider_call_started_at` is set but no response was persisted, mark it `provider_outcome_unknown`; do not automatically issue another Gemini call.
- Surface the unknown status to the user. An explicit retry can create a new request ID and disclose that the previous provider outcome is unknown, so a second generation may consume additional quota.
- Never silently duplicate a possibly successful provider call just to make a request appear successful.

Use `ctx.waitUntil()` to let the active processor finish after the HTTP client disconnects where possible. Schedule an alarm for queued work or lease recovery. Because alarms are at-least-once, the processor must re-read durable state and check its fencing token on every run.

## 5. API and Mini App contract

The current endpoint returns the Gemini response synchronously. Keep the fast path synchronous where it finishes within a bounded wait, but add a request-status contract:

- `POST /api/companion/chat` accepts `requestId` and returns either `200 completed` or `202 { requestId, state: "queued" | "processing" }`.
- `GET /api/companion/requests/:requestId` returns `queued`, `processing`, `completed`, `failed`, or `provider_outcome_unknown`.
- The Mini App generates a UUID once per user action, retains it until a terminal state, and reuses it after timeout/retry.
- On `202`, the UI polls with bounded backoff; do not start a second logical request with a new ID just because the first HTTP response timed out.
- The existing `companionBusy` flag remains a presentation guard only. Server-side request IDs and durable queue state are authoritative.

The Companion persona, general/research quota separation, model choice, and Russian UI remain unchanged by this concurrency migration.

## 6. KV-to-SQLite migration plan

1. Add the `COMPANION_CONVERSATIONS` Durable Object binding and a `new_sqlite_classes` Wrangler migration for `CompanionConversation`. This is a deployment change and must be staged; it is not performed by this ADR.
2. Keep the existing KV key `tenant:<userId>:companion:conversation:<conversationId>` as a legacy source during the migration window.
3. On first open/send for an existing conversation, Worker reads the legacy JSON and passes it to the tenant-scoped DO. The DO imports messages in their original order in one transaction, preserves mode/title/timestamps/sources, and marks `migration_state='ready'` only after commit. The import is idempotent; retrying it cannot duplicate messages.
4. Compare imported message count and a deterministic content hash with the legacy value before marking migration complete.
5. Keep a small KV conversation index (conversation ID, title, mode, updatedAt, messageCount) for list rendering. It is a discovery cache only; conversation history is read from the DO.
6. Retain the old KV blob as a rollback backup for a bounded window (proposed seven days) after verification. Delete it only after the migration health check and rollback window; do not delete it before the DO commit is verified.
7. New conversations are created in the DO and get a KV index entry. Conversation deletion is tenant-checked and idempotently removes DO state plus index/legacy keys.

During rollout, read old conversations from KV and new/migrated conversations from the DO. Do not dual-write full message histories to KV; that reintroduces the lost-update path and consumes KV write quota.

## 7. Alternatives considered

| Option | Decision | Reason |
|---|---|---|
| Keep KV read-modify-write | Reject | Eventual consistency and competing writes can overwrite the same conversation value. |
| KV lock with TTL | Reject | KV is not a strongly consistent compare-and-swap lock service; lock expiry and propagation races remain. |
| In-memory mutex / Promise chain | Reject | Coordinates only one live object instance; it is lost on eviction/restart and does not provide durable request replay. |
| `blockConcurrencyWhile` around Gemini | Reject | Blocks all events, has a 30-second limit/reset behavior, and is unsuitable for a slow external call. |
| One global Companion DO | Reject | All users/conversations contend on one object; poor isolation and a global throughput bottleneck. |
| One DO per user | Not preferred | Safer than one global object, but serializes unrelated conversations for the same user. |
| One DO per tenant/conversation + SQLite queue | **Recommend** | Strongly scoped ordering, transactional state transitions, independent conversations, and durable recovery state. |
| D1 + application lock | Defer | D1 is viable for shared relational data, but per-conversation coordination and queue ownership still need a lock/lease primitive. A conversation DO already provides that boundary. |
| Cloudflare Queues/Workflows | Defer | Durable background processing is viable, but adds service/configuration and an asynchronous API contract. Reconsider if queue throughput or retry requirements outgrow one DO per conversation. |

## 8. Cost and plan guardrails

The earlier draft's blanket statement that this design is "zero additional cost" is **not supportable**.

Cloudflare's current public Durable Objects pricing page lists a Free plan allowance (including daily request, duration, SQLite row-read/write and storage limits) and paid-plan included usage/overage rates. The account's actual plan, current usage, and remaining headroom are not visible from this repository. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

A rough workload estimate for planning only:
- one DO request to enqueue/process a user message, plus status polling when the synchronous fast path exceeds its wait budget;
- approximately 4–10 SQLite row writes per completed message depending on indexes, message rows, request state transitions, and metadata updates;
- no new paid model or external database is required by the recommended design.

For example, 1,000 completed messages/day would be roughly 4,000–10,000 row writes/day before index/storage accounting. This is an estimate, not measured usage or a cost guarantee. Before enabling the new binding in production, check the Cloudflare dashboard for plan, DO request volume, duration, SQLite reads/writes, storage, and any overage exposure. Do not claim unlimited or zero-cost operation.

## 9. Required regression tests

1. **Same conversation, concurrent messages:** two requests arrive while the first Gemini call is pending; both user/assistant pairs persist exactly once and in sequence; second prompt includes the first completed answer.
2. **Cross-tenant isolation:** same `conversationId` under two Telegram user IDs maps to different DOs; reads, writes, deletes, and request status cannot cross tenants.
3. **Duplicate request ID:** retry a completed request returns the exact saved response; Gemini and quota are called once.
4. **In-progress retry:** same ID while a lease is active returns in-progress and does not start a second provider call.
5. **Stale processor fencing:** after lease expiry/reclaim, a delayed old processor cannot finalize with an old fencing token.
6. **Crash before provider call:** expired queued/claimed work can be safely reclaimed.
7. **Crash after provider call started:** request becomes `provider_outcome_unknown`; no automatic second Gemini call.
8. **KV migration:** preserve all messages, order, mode, title, timestamps, and source metadata; repeat import without duplicates; verify count/hash.
9. **List and delete:** index remains correct; deleting one tenant's conversation cannot affect another tenant with the same ID.
10. **API timeout and polling:** 202 status polling reaches a terminal state; client retries reuse the same requestId.
11. **Quota boundaries:** research/global/user quotas remain separate from general Companion quota and are reserved once per logical request.

## 10. Implementation-sized follow-ups

1. **#632 — Backend, CompanionConversation DO:** add binding/migration, SQLite schema, tenant-scoped ID, queue/claim/fencing/finalize, status endpoint, alarm recovery, and Miniflare concurrency/restart tests. Blocked until this ADR is accepted.
2. **#633 — Backend, API and KV migration:** route chat/get/list/delete through the DO, add idempotent lazy import from legacy KV, maintain KV list index, and retain rollback backup window. Depends on #632.
3. **#634 — Frontend, stable request IDs and polling:** generate/reuse requestId per logical send, handle 202/in-progress/unknown states, and add multi-tab/retry UI tests. Depends on #633.

## Conclusion

The current bug is a lost-update race in KV read-modify-write, not a failure of JavaScript's single-threaded execution. A per-tenant/per-conversation SQLite Durable Object with a durable FIFO, atomic claim/fencing, and request replay is the recommended fix. The provider call must remain outside database transactions, and the design must explicitly handle the ambiguous crash window rather than promising exactly-once external calls. Account-specific cost and quota headroom remain unverified until checked in Cloudflare.
