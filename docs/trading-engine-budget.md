# Trading Engine: storage budget and recovery contract

Status: Draft. Do not enable LIVE or deploy this branch before the open issues below are closed.

## Persistence model

- SQLite is the source of truth for accounts, open/closed positions, ledger entries, and one compact engine snapshot per minute.
- Every open/close persists the account balance, position transition, and ledger entry in one `transactionSync` callback.
- Quotes and TP/SL/liquidation indexes are memory-only. No quote tick is written to SQLite.
- After eviction/restart, memory is treated as empty. The constructor restores open positions from SQLite, rebuilds the symbol index, then reconnects the market socket. The subscription snapshot repopulates prices.
- The watchdog uses a 45-second DO Alarm while at least one position is open. Outgoing WebSockets cannot hibernate; Cloudflare says each outbound connection prevents eviction for up to 15 minutes, then normal eviction can resume. The Engine proactively reconnects at about 14 minutes. It checks socket state/silence, forces a reconnect after 14 minutes, restores positions after a disconnect, and checks quote freshness before any execution. With no open positions, the socket and alarm are stopped.
- Quote age defaults to 10 seconds. Older or future-dated quotes are rejected for open/close execution.
- A gap is executed using the current fresh quote with adverse slippage, not the crossed TP/SL/liquidation level.

## Cloudflare Workers Free SQLite quotas

Current Cloudflare documentation lists 5,000,000 SQL rows read/day, 100,000 SQL rows written/day, and 5 GB stored data/account for SQLite-backed Durable Objects. Every `setAlarm()` counts as one row written. Free operations fail when a quota is exceeded; daily counters reset at 00:00 UTC.

Sources:
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/\n- https://developers.cloudflare.com/durable-objects/best-practices/websockets/\n- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

## Daily write estimate

Let:
- N = users with a seeded demo account;
- M = total simultaneously open positions across all users (if each user averages m positions, M = N*m);
- E = total trade events/day, where one event is one open or one close.

Worst-case always-on watchdog with at least one open position:
- 45-second alarms: 86,400 / 45 = 1,920 alarm writes/day;
- one snapshot row/minute: 1,440 writes/day;
- each trade event: 1 account row + 1 position row + 1 ledger row = 3 writes;
- first-time account seed: 1 account row + 1 ledger row = 2N writes.

Estimated writes: W = 3,360 + 3E + 2N.

| N users | Avg positions/user | M total | E events/day | Estimated writes/day | Free quota used |
|---:|---:|---:|---:|---:|---:|
| 100 | 2 | 200 | 2,000 | 9,560 | 9.56% |
| 1,000 | 2 | 2,000 | 20,000 | 65,360 | 65.36% |
| 1,000 | 5 | 5,000 | 50,000 | 155,360 | 155.36% |

This is a conservative alarm/snapshot model, not a measured production profile. It excludes schema migrations and exceptional retries. The 1,000-user / 5-position scenario does not fit the Free write quota at 50,000 events/day.

## Daily read estimate

Let K = number of full Engine restorations/day, C = close events/day, A = account-view requests/day, and P = total open positions returned by account views.

Approximate indexed-row model:
R ≈ K*M + E + C + A + P.

- One restore reads M open-position rows.
- Open reads one account row.
- Close reads one account row and one position row.
- Account view reads one account row plus that user's open positions.
- The watchdog does not query SQLite per market tick. Full SQL restoration occurs on cold start/reconnect, not each tick.
- Ledger audit is deliberately an explicit reconciliation operation, not a per-tick operation. Its cost grows with ledger history and must be included if automated frequently.

Actual row-read billing depends on rows scanned by SQL execution plans, not merely the number of SQL statements or result objects. Measure real usage before scaling.

## allMids measurement

Run GitHub Actions → `measure-hyperliquid-allmids` → `Run workflow`. It opens a real Hyperliquid WebSocket for 10 minutes and prints message count, mean messages/sec, median, p95, min and max inter-message gaps. The measurement has not yet been run from the GitHub runner, so no feed frequency is claimed here.

A third-party observation from 27 Oct 2026 reported about 5-second median allMids message gaps over a short 20–30 second sample. This is not an official SLA and is not a substitute for our 10-minute run:
https://ironflow.sh/guides/hyperliquid-websocket-api

## WebSocket billing

Cloudflare's current pricing documentation says outgoing WebSocket messages are not charged as DO requests. Incoming WebSocket messages use a 20:1 request-billing ratio; protocol pings are not charged. This is documented, not inferred from a local usage experiment:
https://developers.cloudflare.com/durable-objects/platform/pricing/

## Fallback if the DO Free budget is insufficient

A separate always-on process can own the Hyperliquid WebSocket and send an authenticated event to the Worker only when a watched symbol approaches/crosses an indexed level. The Engine must still:
1. validate the event's authentication, timestamp, symbol and price;
2. reject stale quotes;
3. load/confirm the persisted open position;
4. recompute liquidation/SL/TP using the received current quote;
5. close inside one SQLite transaction and append the ledger row exactly once.

This reduces DO socket duration and incoming DO WebSocket traffic; it does not remove the need for a fresh trusted quote or atomic Engine execution. A genuinely free always-on host is not guaranteed. Oracle Cloud Always Free is a possible candidate, but capacity, account eligibility and regional availability must be verified before relying on it. No paid fallback is authorized.

## Known limitations to close before production

- allMids ten-minute measurement has not yet been run.
- DO outbound WebSocket reconnect and 14-minute lifetime behavior need a real Cloudflare runtime check.
- Demo liquidation uses a fixed 0.5% maintenance-margin estimate. It is not a market-specific Hyperliquid liquidation tier and must be labeled as an estimate.
- The Mini App still needs to switch its manual LONG/SHORT UI to the new /api/demo endpoints.
- No LIVE exchange execution is implemented or permitted.
