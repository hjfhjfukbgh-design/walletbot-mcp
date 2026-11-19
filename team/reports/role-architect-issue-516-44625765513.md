# ARCHITECT — проверка AI LIVE control architecture (#516)

- Режим: анализ, исходники не изменялись.
- Общий вердикт: **NOT VERIFIED / BLOCKED FOR LIVE RELEASE**.
- Цель отчёта — отличить описанные требования от реально реализованной архитектуры. Наличие таблиц/README не считается доказательством работающей сессии.

## Scope matrix

| ID | Проверка | Evidence | Статус | Пробел |
|---|---|---|---|---|
| S1 | Три режима MANUAL LIVE / AI PAPER / AI LIVE | README.md:L7-L17, src/api.ts:L54-L80, miniapp/web/index.html:L28-L34 | PARTIAL | UI имеет DEMO/AI и disabled LIVE; AI PAPER fund/withdraw/status есть. Session-start AI LIVE route/runner отсутствует. |
| S2 | Session expiry/revoke, kill switch, server-side capital/notional/leverage/positions/daily-loss limits, preview freshness | src/trading/engine.ts:L72-L80, src/api.ts:L357-L480, src/api.ts:L527-L680 | NOT VERIFIED | Таблицы AI paper не являются AI LIVE session store. В reviewed source не найдено session authorization state, revoke/kill-switch endpoint или per-order AI LIVE session guard. Open LIVE flow не равен автономной session. |
| S3 | AI paper ledger isolation/idempotency и positions/decisions isolation | src/trading/engine.ts:L74-L79, L289-L305, L312-L388, L393-L466; test/trading-engine.miniflare.test.ts:L90-L300; test/api.test.ts:L133-L174 | PARTIAL | AI paper balance/ledger operations scoped by user_id and tested; ai_paper_positions/ai_paper_decisions are schema-only in reviewed engine code, with no execution/write surface to verify. |
| S4 | Fail-closed: no real Walt writes, transfers, account mutation, secrets or deploy during development/tests | src/walt.ts:L74-L92; README.md:L7, L59-L60 | PASS (development guard) | This verifies current blocked legacy methods and project policy, not a production AI LIVE design. |
| S5 | State machine, API contract, threat model, persistence/idempotency design and test matrix | src/api.ts:L54-L80; src/walt.ts:L74-L92; README.md:L99-L104 | NOT VERIFIED | No complete AI LIVE session state machine or API contract exists in the reviewed implementation. |

## Verified facts

1. The active Mini App exposes DEMO and AI PAPER; LIVE selector is disabled in index.html:L28-L34.
2. API routes expose AI paper status/fund/withdraw and manual LIVE open preview/execute/status; no AI LIVE session-start/stop/revoke route appears in the reviewed route switch (src/api.ts:L54-L80).
3. Current LIVE open execution is user-confirmed and uses preview/claim/execute/reconciliation flow in src/api.ts:L357-L480 and L527-L680. This is not an autonomous AI LIVE session.
4. Legacy Walt wrappers fail closed (src/walt.ts:L74-L92). The report does not infer a supported close tool name or schema from them.
5. AI paper schema separates account/ledger/positions/decisions tables, but the reviewed engine implements account/status/fund/withdraw operations; schema presence alone does not prove position/decision execution or complete tenant isolation.

## Missing architecture before AI LIVE can be considered

- Durable session record bound to Telegram user and exact Walt account/owner.
- One explicit user Start AI LIVE authorization, scoped to one session; expiry and revocation; session-specific kill switch.
- Immutable server-side limits: allocated capital, per-order notional, contract leverage ceiling, max open positions, daily loss stop, stale-price/preview expiry.
- Before each AI order: auth + account ownership + readiness + balance + contract rules + all limits.
- Idempotent order operation state, durable audit, GET-only reconciliation for unknown outcomes, no blind execute retries.
- Explicit deny of withdraw/transfer/account-management permissions.
- Mocked cross-tenant, replay, expiry, revocation, kill-switch, limit-breach, timeout/unknown, balance-mismatch tests.
- Walt close prepare/execute/reconciliation contract remains blocked by #332; do not expose LIVE trading UI or AI LIVE runner until this is verified.

## Conclusion

**NOT VERIFIED / BLOCKED.** Requirements for supervised AI LIVE are documented, but the required session authorization, execution state machine, and safety enforcement are not implemented in the reviewed code. Keep LIVE disabled. No real Walt writes, orders, transfers, account mutations, secrets or production deploy were performed.
