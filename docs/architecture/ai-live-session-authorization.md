# ADR: supervised AI LIVE session authorization

- Status: **Proposed — implementation blocked**
- Scope: MANUAL LIVE, AI PAPER and AI LIVE execution boundaries.
- Related: #332 (Walt close contract), #516 (supervised AI LIVE), #517 (backend), #518 (Mini App).
- This document is a design proposal, not evidence that AI LIVE exists or is enabled.

## Decision

Keep three execution modes distinct:

1. **DEMO** — virtual user trading account.
2. **AI PAPER** — autonomous strategy simulation against a separate virtual ledger. It has no Walt write permission.
3. **MANUAL LIVE** — a user explicitly confirms each real order.
4. **AI LIVE** — a user explicitly starts one bounded authorization session. After that single session confirmation, the AI may submit orders without per-order prompts, but the server independently validates every order against immutable session limits.

DEMO remains the default. MANUAL LIVE and AI LIVE are disabled until the full Walt open **and close** contracts are verified. AI LIVE must never start automatically, resume after expiry, or inherit authorization from a previous session.

## Non-negotiable invariants

- The server, not the model or Mini App, owns authorization, account binding, limits, order state, idempotency and audit.
- The session is bound to the authenticated Telegram user and one exact Walt account. A client-supplied user/account identifier is never sufficient proof of ownership.
- The user authorizes the session once; this is not a blanket or permanent account permission.
- Capital, max order notional, contract leverage ceiling, max open positions, max daily loss and expiry are fixed for the life of a session. Changing any limit requires stopping and starting a new session.
- The model receives no withdraw, transfer, API-key, OAuth-token or account-management capability.
- Every order is checked server-side immediately before the only permitted execute attempt.
- Unknown execution outcome means **no retry**. Reconcile read-only; if the outcome cannot be established, pause the session and require human intervention.
- Stop/revoke/expiry blocks new orders immediately. It does not blindly close existing positions.
- No AI LIVE execution or UI release until #332 supplies the exact Walt close prepare/execute/reconciliation contract and mocked open→close evidence.

## State machines

### Session lifecycle

`PENDING_CONFIRMATION → ACTIVE → PAUSED → ACTIVE` is permitted only when the pause reason is transient and the same authorization is still valid. The following transitions are terminal:

- `ACTIVE → STOPPING → STOPPED`
- `ACTIVE → EXPIRED`
- `ACTIVE → REVOKED`
- `ACTIVE → KILLED`
- `ACTIVE → BLOCKED` on risk breach, ownership/auth mismatch, unknown execution outcome, stale/invalid contract data or reconciliation failure.

A terminal session cannot be resumed. A new explicit user start is required.

### Order operation lifecycle

`CREATED → VALIDATED → PREPARED → CLAIMED → EXECUTING → COMPLETED`

Exceptional states:

- `REJECTED`: validation failed before any Walt write.
- `UNKNOWN`: execute outcome is ambiguous (timeout, disconnect, invalid response).
- `RECONCILED_COMPLETED` / `RECONCILED_NOT_EXECUTED`: established by read-only reconciliation.
- `FAILED`: a definitive failure response proves no order was placed.

Only one worker may atomically claim an operation. No code path may transition UNKNOWN back to EXECUTING or issue a second execute request.

## Proposed persistence model

Use the existing account-scoped Durable Object as the serialization boundary, with SQLite as durable source of truth. These are proposed tables; they are **not present or implemented yet**.

### `ai_live_sessions`

| Field | Purpose |
|---|---|
| `session_id` | Opaque random identifier; never a bearer secret |
| `user_id`, `account_id` | Immutable authenticated owner and exact Walt account binding |
| `status` | Session lifecycle state |
| `allocated_capital_micro` | Maximum capital authorized for the session |
| `max_order_notional_micro` | Per-order notional ceiling |
| `max_leverage` | Contract-specific leverage ceiling |
| `max_open_positions` | Concurrent position cap |
| `max_daily_loss_micro` | Daily net-loss stop |
| `created_at`, `expires_at`, `revoked_at`, `updated_at` | Authorization lifecycle timestamps |
| `start_idempotency_key` | Unique per authenticated user/account start request |
| `limits_json` | Canonical immutable server-validated limits; audit copy only |

### `ai_live_operations`

Primary key/unique constraint: `(session_id, idempotency_key)`.

Persist operation status, server-generated preview hash, preview expiry, contract identifier, side, notional reservation, leverage, request fingerprint, provider operation handle, result summary and timestamps. Never persist raw credentials or expose provider secrets to the model.

### `ai_live_audit`

Append-only audit events for session start/stop/revoke/kill, every validation decision, limit rejection, operation claim, execute attempt, unknown result and reconciliation. Record actor, owner, session, operation, timestamp and reason. Do not store secrets or full sensitive provider payloads.

## Proposed API contract (not implemented)

These names are internal proposals only; do not expose them or assume they exist until a separate implementation PR is reviewed.

- `POST /ai/live/session/preview`: validate user/account readiness and proposed limits; return a short-lived summary for user review. No authorization is created.
- `POST /ai/live/session/start`: requires explicit user confirmation plus an idempotency key; atomically create one ACTIVE session bound to user/account/limits.
- `GET /ai/live/session/status`: return server-owned status, limits, expiry and stop reason.
- `POST /ai/live/session/stop`: idempotently revoke the session and prevent new order claims.
- `POST /ai/live/session/kill`: emergency server-side kill switch; revoke all active AI LIVE sessions for the authenticated owner (and provide an operator-level global kill path).

No session token or Walt credential is returned to the model or stored in localStorage. The Mini App may display an opaque session ID for status correlation, but authorization is checked server-side on every request.

## Per-order authorization algorithm

1. Authenticate the request from signed Telegram initData; derive `user_id` on the server.
2. Load session by both `session_id` and `user_id`; verify exact account ownership and ACTIVE status.
3. Check expiry, revocation, kill switch and immutable limits.
4. Fetch authoritative account balance and open positions; reject stale, unavailable or inconsistent state.
5. Validate symbol/contract, contract-specific leverage ceiling, notional, available capital, open-position count and daily net loss (realized + unrealized, fees included).
6. Obtain a fresh server-side price and short-lived preview. Client-provided risk numbers are ignored.
7. Atomically reserve the operation/idempotency key and enforce session exposure caps. The transaction ends before any network call.
8. Execute at most once through a verified Walt adapter contract. Persist definitive result or UNKNOWN.
9. On UNKNOWN, pause the session and perform GET/read-only reconciliation only. Never blind-retry execute. If reconciliation remains ambiguous, keep BLOCKED and require a human.
10. Append audit events for every state transition.

A Durable Object may process another request while an earlier handler is awaiting an external provider call. Therefore, do not rely on a plain in-memory mutex or a transaction held across network I/O. Use durable operation records and short SQLite transactions for claim/reservation/finalization.

## MANUAL LIVE remains separate

MANUAL LIVE requires a fresh server preview and a separate explicit confirmation for **each** order. The execute endpoint accepts a single-use confirmation/operation handle and is idempotent. A manual confirmation cannot authorize an AI LIVE session, and an AI LIVE session cannot be used to bypass manual per-order confirmation.

## Provider semantics research (not an API contract)

Walt's public Help Center documents an **Agentic account** as a separate-balance subaccount for an AI assistant. It states that the agent cannot top up/withdraw or access the main balance, and that stopping the account disconnects the agent, closes open perpetual positions and returns the remaining balance. It also states one open position per perpetual contract per account, while different contracts can be held concurrently. See [Walt Agentic account](https://help.walt.io/article/1153-agentic-account).

Walt's perpetuals guide states that opening/closing fees are tier-dependent percentages of position size deducted from margin, and funding can be charged or credited hourly and changes margin. See [Walt trading, fees and funding](https://help.walt.io/article/634-trade-and-trading-assets-in-wallet).

These are product semantics, **not verified MCP tool schemas**. The current adapter must not assume it can create/stop an Agentic account, list all positions, fetch daily PnL, or close positions through the same capability. Verify exact MCP tools, input/output schemas, ownership binding and operation states before using this model. Fee and daily-loss controls must include trading fees and funding; aggregate exposure must account for multiple contracts. Never implement an assumed endpoint or payload from Help Center prose.

## Walt adapter dependency

The adapter must expose typed capabilities only after the corresponding provider contract is verified:

- open prepare / execute / read-only reconcile;
- close prepare / execute / read-only reconcile.

The close capability is currently **NOT VERIFIED**. Do not guess a tool name, request schema, reduce-only flag, quantity semantics or response shape. #332 must establish exact close contract evidence and mocked open→close lifecycle first. Until then, AI LIVE session start must fail closed and LIVE stays disabled.

## Required mocked test matrix

- Start: valid opt-in, missing opt-in, duplicate start key, same key across users, wrong account owner.
- Session: expiry, revoke, kill switch, terminal-session resume rejection, changed limits require a new session.
- Tenant isolation: same session/operation IDs across users, foreign session/operation read and mutate attempts.
- Risk: capital, order notional, leverage, positions, daily loss, stale price, expired preview, balance mismatch, missing contract.
- Concurrency: duplicate order request, two simultaneous claims, duplicate tick, worker restart after claim, crash before execute, crash after execute before finish.
- Unknown: timeout/disconnect, malformed provider response, read-only reconciliation success/failure, prove there is never a second execute.
- Permissions: AI cannot withdraw, transfer, change account settings or retrieve credentials.
- Manual LIVE: one confirmation per order; no reuse of confirmation handle.
- Close: mocked prepare→confirm/authorized session→execute→reconcile only after #332 provides the exact contract.

## Release gates

1. #332 verifies Walt close contract and mocked open→close reconciliation.
2. Backend implementation PR adds durable session/operation/audit persistence and mock tests; all tenant/risk/idempotency tests pass.
3. Security review verifies ownership, revocation, kill switch, limits and no blind retries.
4. Mini App PR implements one-time session start, clear limits/expiry/status and Stop; no fake controls.
5. DEMO, AI PAPER and MANUAL LIVE regressions pass; AI LIVE remains disabled until explicit release authorization.
6. Production deployment requires separate explicit approval.

**Current status: design proposal only. AI LIVE is not implemented, not enabled and not authorized for real trading.**
