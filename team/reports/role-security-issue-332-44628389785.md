# SECURITY — LIVE order safety and reconciliation audit (#332)

- Mode: read-only source and mocked-test audit. No Walt write calls or real account access.
- Overall verdict: **NOT VERIFIED / BLOCKED FOR LIVE RELEASE**.
- Scope: current MANUAL LIVE open path only. AI LIVE session authorization and LIVE close are not implemented.

## Findings matrix

| ID | Control | Evidence | Verdict | Finding |
|---|---|---|---|---|
| S1 | Telegram authentication before body parsing | `src/api.ts:L25-L47`; `test/live-execution.test.ts:L18-L40` | PASS | Signed Telegram initData is validated before POST body parsing; user ID is server-derived. |
| S2 | Tenant-scoped OAuth/KV and operation ownership | `src/tenants.ts:L12-L45`; `src/api.ts:L40-L65`; `src/trading/engine.ts:L199-L258`; `test/live-execution.test.ts:L151-L174` | PARTIAL | Preview token is stored under tenant-prefixed KV; DO operation is bound to user_id and foreign handle returns 404. However, the LIVE preview path does not explicitly compare a Walt account identifier/owner returned by Walt to a user-selected account identity. Token namespace binding is present; exact provider-account ownership evidence is incomplete. |
| S3 | Market allowlist, order sizing, leverage, exposure, daily loss, fees | `src/api.ts:L354-L463`; `src/env.ts:L34-L55`; `src/risk.ts:L14-L39`; `src/walt.ts:L40-L72` | **FAIL / NOT VERIFIED** | LIVE preview enforces allowed market, contract max leverage, contract min/max quote size, positive balance, margin ≤ balance, and no existing position on the selected contract. It does **not** apply configured `maxOrderPct`, `maxTotalExposurePct`, or `maxDailyLossPct`; it checks only the selected contract, not aggregate exposure across all contracts. No local fee cap/fee affordability check is made; Walt preview risk/warnings are returned but warnings are not independently evaluated. |
| S4 | Preview confirmation token, per-order confirmation, expiry | `src/api.ts:L354-L480,L527-L558`; `test/live-execution.test.ts:L129-L149,L271-L306`; `test/api.test.ts:L180-L194` | PASS | Opaque random handle is user-scoped; Walt confirmation token is held server-side; 120-second TTL/expiry is checked; execute requires `confirm === true`. |
| S5 | Idempotency and exactly-one execute attempt | `src/api.ts:L559-L610`; `src/trading/engine.ts:L199-L258`; `test/live-execution.test.ts:L85-L126` | PASS (mocked) | Durable Object SQLite transaction claims a handle once; concurrent/replayed execute requests do not call Walt a second time. |
| S6 | Recheck position immediately before execute | `src/api.ts:L559-L595`; `test/live-execution.test.ts:L176-L229,L330-L340` | PARTIAL | A read-only position check occurs immediately before the only execute call and fails closed if unavailable. It checks only the selected contract; an external/manual position can still appear in the small interval between this check and the Walt write. |
| S7 | UNKNOWN handling and reconciliation | `src/api.ts:L612-L691`; `src/api.ts:L600-L610`; `test/live-execution.test.ts:L176-L260` | PARTIAL | Uncertain execute outcomes become UNKNOWN; reconciliation uses read-only `perps_list_positions` and compares contract/side/open-time. It does not reconcile by a verified provider order ID; side/time matching can be ambiguous if another position appears in the same window. |
| S8 | No blind execute retry | `src/api.ts:L596-L610,L612-L691`; `test/live-execution.test.ts:L231-L260` | PASS (mocked) | One execute call is made; uncertain outcome remains UNKNOWN; later request returns prior status and performs read-only reconciliation, not a second execute. |
| S9 | LIVE close prepare/execute/reconciliation contract | `src/api.ts:L54-L80`; `src/walt.ts:L74-L106` | NOT VERIFIED / NOT IMPLEMENTED | No LIVE close preview/execute route or verified close tool/schema exists. Legacy `closePosition` throws and fails closed. Do not guess Walt close tool names or request fields. |
| S10 | AI LIVE session authorization | `src/api.ts:L54-L80`; `docs/architecture/ai-live-session-authorization.md` | NOT IMPLEMENTED | No session-start/revoke/kill-switch API or autonomous AI LIVE runner exists. The ADR is a proposal, not implementation. |

## Detailed verified behavior

### Authentication and tenant boundary

- `handleApi` validates signed Telegram initData and derives `telegramUserId` before reading the request body (`src/api.ts:L25-L47`).
- `tenantEnv` prefixes user KV state and OAuth token keys (`src/tenants.ts:L12-L45`).
- Preview handles are stored as `live:preview:<userId>:<handle>`; a different Telegram user cannot retrieve the owner's preview (`src/api.ts:L440-L480`; test `test/live-execution.test.ts:L151-L174`).
- Durable operation rows store `user_id`; cross-user status/claim lookup returns not found (`src/trading/engine.ts:L199-L258`).

### Open risk checks — confirmed gap

The current LIVE preview validates:
- active contract and allowlist;
- contract metadata and max leverage;
- selected-contract position absence;
- current price and non-negative account balance;
- margin no greater than current balance;
- notional within contract min/max;
- Walt `perps_prepare_order_place` returns `ok` plus confirmation token.

But the configured risk policy also contains max order %, max total exposure %, max daily loss %, stop-loss %, and minimum volume (`src/env.ts:L34-L55`). The LIVE preview path does not call `checkOpen` and does not enforce max order %, aggregate exposure %, or daily loss. It also does not calculate/validate a local fee allowance from `takerFeePct`. This is a release blocker, not a cosmetic TODO.

### Execute, idempotency and UNKNOWN

- Execute requires explicit per-order confirmation and a valid 32-character handle.
- Preview expiry is checked before connecting to Walt.
- Durable Object `transactionSync` inserts one `live_operations` claim; duplicate claim is rejected.
- Position is re-read immediately before execute; a position/read error prevents the Walt write and records UNKNOWN.
- Exactly one `perps_execute_operation` call is made.
- Any uncertain provider result becomes UNKNOWN. A later GET status request uses read-only position lookup; no execute retry is made.
- Reconciliation is only partial because the reviewed provider data is matched by contract/side/time, not a verified order identifier.

## Required remediation before LIVE

1. Apply server-side LIVE risk caps: max order %, aggregate exposure %, daily loss, and fee affordability; fail closed if authoritative inputs are missing.
2. Verify exact Walt account identity/ownership against the authenticated Telegram tenant.
3. Obtain a provider-supported unique order/operation identifier and use it for reconciliation; do not infer order ownership from side/time alone.
4. Verify the exact Walt close prepare/execute/read-only reconciliation contract and add mocked open→close E2E evidence. Do not invent tool names or schemas.
5. Only after #1–#4, unblock manual LIVE UI. AI LIVE additionally requires the session architecture in the merged ADR, implemented with durable session authorization, expiry/revoke/kill switch and server-side per-order limits.
6. Keep DEMO default, LIVE disabled, and production deploy separately authorized.

## Tests and safety boundary

- `test/live-execution.test.ts` covers explicit confirmation, concurrent single-claim, expired preview, cross-tenant preview denial, pre-execute position guard, unavailable position read, UNKNOWN/no-retry, preview contract and existing-position denial.
- Main CI run `44630321694` passed npm ci, JS syntax, typecheck and npm test.
- Tests use mocks. No real Walt writes, orders, transfers, account mutations, secret changes or production deploy were performed.

**Final verdict: NOT VERIFIED / BLOCKED.** The manual LIVE open path has meaningful auth, preview, confirmation, atomic claim and no-retry safeguards, but configured risk limits are not fully enforced, account identity and reconciliation are partial, and the LIVE close contract is absent. AI LIVE is not implemented.
