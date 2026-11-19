# Kripto Guru — AI Trading architecture baseline

**Дата:** 2026-11-18  
**Основа:** read-only review of `main`; runtime и внешние API не тестировались.  
**Граница:** только DEMO / paper. Ни одного реального ордера, перевода или изменения аккаунта.

## Executive verdict

В репозитории уже есть серьёзная основа для симулятора деривативов: per-user DEMO balance, позиции, ledger, fixed-point money, fee/slippage, stale quote guard, TP/SL/liquidation monitoring и risk checks внутри Durable Object. Но это **не AI Trading product**: AI decision engine, отдельный AI account namespace, strategy lifecycle, decision journal и evaluation dashboard пока отсутствуют.

## Что подтверждено в коде

### Существующая paper trading core

- `src/index.ts` экспортирует Durable Object `TradingEngine`; binding `ENGINE` объявлен в `wrangler.toml`.
- `src/trading/engine.ts` создаёт SQLite tables:
  - `accounts(user_id, balance_micro)`;
  - `positions(id, user_id, symbol, status, position_json, ...)`;
  - `ledger(operation_id UNIQUE, user_id, position_id, kind, amount_micro, balance_before_micro, balance_after_micro, created_at)`;
  - `engine_meta` для snapshot.
- `ensureAccount(userId)` выдаёт DEMO seed $1,000 и создаёт seed ledger event.
- `open()` требует `mode === "demo"`; любое другое значение отклоняется. Проверки маржи, общей экспозиции и дневного лимита выполняются внутри Durable Object перед атомарной записью.
- `close()` проверяет владельца позиции, требует свежую котировку и атомарно обновляет баланс, позицию и ledger.
- `reconcile()` сверяет последовательность ledger и текущий account balance.
- `freshQuote()` блокирует открытие/закрытие при отсутствующей или устаревшей котировке.
- `alarm()` следит за свежестью WebSocket feed, переподключает socket и использует HTTP allMids fallback.
- `src/trading/positions.ts` содержит чистую арифметику открытия/закрытия, adverse slippage, fees, TP/SL/liquidation triggers.
- `src/trading/money.ts` использует BigInt fixed-point и явные правила округления.

### Текущий API/UI

- `src/api.ts` предоставляет DEMO endpoints: account view, history, preview, open, close; запросы Mini App аутентифицируются через Telegram init data, после чего используется tenant-scoped env.
- Engine routes: GET `/account`, `/history`, `/risk`, `/health`; POST `/open`, `/close`, `/quote`, `/reconcile`.
- Frontend вызывает `markets.list`, `wallet.get`, `history.list`, `capabilities.get`, `market.get`, `market.candles`, `trade.preview/open/close`.
- Это DEMO торговый контур. В UI и API нет подтверждённого AI account / strategy / decision journal / AI chat endpoints.

## Главные архитектурные пробелы

1. **Нет отдельного AI account.** Существующая таблица accounts keyed by user_id и позиционная модель user_id-scoped; отдельного account_id/account_kind для обычного DEMO и AI paper нет. Нельзя просто переиспользовать DEMO balance: AI paper должен иметь независимый ledger, баланс, позиции и историю.
2. **Нет AI decision pipeline.** Не найдено реализации feature extraction, strategy registry, signal evaluation, rationale, confidence calibration или versioned strategy runs.
3. **Нет decision journal.** История хранит open/close события и equity series; нет записи наблюдения, входного snapshot, версии стратегии, причины входа/отказа, risk decision и outcome linkage.
4. **Метрики ограничены.** Нет готового набора drawdown, expectancy, win rate по стратегиям, exposure history, fees/slippage attribution и benchmark.
5. **Нет orchestration для paper strategy.** Durable Object следит за котировками и позициями, но AI planner/strategy scheduler и kill-switch для конкретной стратегии не обнаружены.
6. **Нет подтверждённого model path.** В `package.json` нет AI SDK/model dependency; в дереве исходников не найдено Companion/AI Trading backend. Нельзя заявлять, что универсальный AI уже работает бесплатно или подключён.
7. **Разделение LIVE/DEMO должно быть не только UI-флагом.** Существующий engine принимает только DEMO mode; AI paper должен быть отдельным явно типизированным execution domain без доступа к Walt write/execute methods.

## Рекомендуемая целевая архитектура

### Domain model

- `TradingAccount`: `accountId`, `userId`, `kind = demo | ai_paper`, `currency`, `status`, `createdAt`.
- `AccountLedgerEntry`: immutable `operationId` (unique), `accountId`, `kind`, `amountMicro`, `balanceBeforeMicro`, `balanceAfterMicro`, `positionId?`, `strategyRunId?`, `createdAt`.
- `PaperPosition`: `accountId`, `strategyId`, `strategyVersion`, `symbol`, `side`, `margin`, `leverage`, `entry/mark/TP/SL/liquidation`, `fees`, `slippage`, `status`.
- `Strategy`: `strategyId`, `ownerUserId`, `version`, `config`, `riskProfile`, `enabled`, `paperOnly=true`.
- `StrategyRun`: input snapshot reference, quote timestamp, strategy version, output, status, latency, failure reason.
- `DecisionJournalEntry`: observedAt, market snapshot, hypothesis, signal, rationale, confidence, risk checks, action (enter/hold/reject/exit), linked position, outcome.
- `RiskProfile`: max order bps, max total exposure bps, max daily loss bps, max leverage, allowed markets, max concurrent positions, stale quote threshold.

### Isolation invariants

1. Every read/write carries authenticated `userId` and server-derived `accountId`; never trust account ownership from client input.
2. DEMO and AI paper use distinct account IDs and independent ledger chains. Funding DEMO → AI paper is an explicit internal transfer with paired debit/credit entries and one idempotency key; no external transfer.
3. Ledger is append-only. Corrections are compensating entries, not edits/deletes.
4. Position, ledger and balance mutations occur in one Durable Object transaction.
5. AI paper execution has no import, binding, tool capability or code path to Walt order/write methods.
6. LIVE remains unavailable in AI Trading. Any future LIVE work requires a separate product/security review and explicit user authorization; not part of this implementation.
7. Quote age and source are attached to every decision. Stale/missing market data means HOLD / reject, never synthetic prices.
8. Every strategy run is reproducible from immutable inputs, strategy version and risk profile version.

### Main flows

**Fund AI paper account**
1. Authenticate Telegram user.
2. Resolve the user's DEMO and AI paper accounts server-side.
3. Validate positive amount and sufficient DEMO balance.
4. In one transaction, append DEMO debit + AI paper credit with shared transfer ID and idempotency key.
5. Return both balances and immutable transfer record.

**Evaluate strategy**
1. Scheduler obtains fresh quote/candle snapshot.
2. Persist input snapshot metadata and strategy version.
3. Strategy computes signal + rationale; no side effects.
4. Risk engine checks freshness, market allowlist, exposure, loss limits, leverage, TP/SL and sizing.
5. Decision journal records ENTER / HOLD / REJECT with all checks.
6. If approved, paper executor calls only the AI paper ledger/position service.
7. Update outcome and metrics from realized paper events.

**Stop strategy**
1. Disable strategy scheduling immediately.
2. Prevent new entries.
3. Preserve open positions and their configured paper TP/SL policy; offer explicit paper close separately.
4. Record stop reason and actor in journal.

## API contract proposal

- `GET /api/ai-trading/account` — AI paper balance, equity, open positions, account status.
- `POST /api/ai-trading/funding/preview` — validate DEMO → AI paper allocation; no mutation.
- `POST /api/ai-trading/funding/confirm` — idempotent internal virtual transfer, explicit confirmation required.
- `GET /api/ai-trading/strategies` / `POST /api/ai-trading/strategies` — list/create strategy configuration.
- `POST /api/ai-trading/strategies/:id/run` — request one bounded paper evaluation; no LIVE mode.
- `POST /api/ai-trading/strategies/:id/pause` — safe stop for new entries.
- `GET /api/ai-trading/journal` — paginated decisions and linked outcomes.
- `GET /api/ai-trading/metrics` — equity, drawdown, win rate, expectancy, exposure, fees, slippage.

All endpoints derive tenant identity from validated Telegram init data, validate schemas, use server-side account resolution and return explicit stale-data / blocked states.

## Implementation sequence

1. **AI-01 Account isolation:** schema migration to account_id/account_kind; preserve existing DEMO balances; add independent AI paper seed/allocation, paired idempotent ledger transfers and reconciliation tests.
2. **AI-02 Paper execution boundary:** service interface that accepts only AI paper account IDs; prove no Walt write dependency/import reachable from this module.
3. **AI-03 Strategy registry & run lifecycle:** versioned strategy config, scheduler, immutable input snapshots, bounded retries and stop controls.
4. **AI-04 Risk engine:** reuse fixed-point primitives; centralize bps limits and freshness; persist per-check result; fail closed.
5. **AI-05 Decision journal:** event schema for observations, rationale, risk checks, action, position link and outcome.
6. **AI-06 Metrics:** compute equity curve, drawdown, expectancy, win rate, exposure, fees and slippage from ledger/events; tests against fixtures.
7. **AI-07 AI interfaces:** API/UI for account, strategy, journal, metrics and explicit paper mode; do not expose non-functional controls.

## Open decisions before implementation

- Whether AI paper starts with a fixed independent seed or only explicit allocation from DEMO. Recommended: explicit transfer, with a clearly labelled one-time demo seed only if product owner chooses.
- Which strategy types are first-class (rule-based baseline first; LLM explanation separate from deterministic execution).
- Which free model/runtime is actually available under the current budget. Do not add a paid provider or assume free quotas.
- Whether AI Companion and AI Trading share conversation storage. Recommended: shared conversation infrastructure with separate tool scopes and separate AI Trading decision journal.

## Acceptance gates

- Tests prove DEMO and AI paper balances/positions/ledger cannot cross-read or cross-mutate.
- Duplicate funding request is idempotent.
- Ledger reconcile passes after open, close, transfer and crash/retry simulations.
- Stale quotes block new AI paper entries.
- Every decision is journaled, including HOLD/REJECT.
- Strategy stop blocks new entries immediately.
- AI paper module cannot access Walt write/execute APIs.
- All calculations use fixed-point primitives; no floating-point financial math.
- No production deploy, merge, real orders or fund movement in this work.
