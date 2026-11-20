# SECURITY — анализ задачи #558

- Режим: анализ, исходники не изменялись
- Задача: [KG-A-SECURITY] Enforce manual LIVE risk caps and account ownership

<!-- kg-child-task:v1;parent=332;key=live-risk-caps-01;team=A;role=SECURITY;depends=none -->
## Goal
Close the remaining manual LIVE preview safety gaps identified in the read-only audit. This is a code-and-mocked-tests task only; it must not enable LIVE or perform real Walt writes.

## Required work
1. Enforce `MAX_ORDER_PCT` in `previewLiveTrade` using authoritative Walt balance.
2. Verify the exact Walt read contract for account-wide open positions and daily PnL. Do not guess tool names or payload schemas. If either metric cannot be obtained and validated, fail closed before prepare.
3. Enforce `MAX_TOTAL_EXPOSURE_PCT` against all account positions, not just the selected contract. If aggregate exposure cannot be calculated reliably, reject the preview.
4. Enforce `MAX_DAILY_LOSS_PCT` from authoritative daily equity/PnL, including fees. If unavailable or stale, reject.
5. Validate fee inputs and reserve estimated taker fees using verified contract fee semantics; reject invalid/missing fee data.
6. Verify the exact Walt account identity/owner bound to the authenticated Telegram tenant. Do not trust client account IDs.
7. Add mocked tests for each cap, missing/stale data, cross-account ownership, and fail-closed behavior.

## Hard boundaries
- Keep `LIVE_TRADING_ENABLED` unset/false. Do not enable LIVE product mode or UI.
- No real Walt prepare/execute/write calls, real orders, position mutations, transfers, account changes, secrets or production deploy.
- No guessed provider tool names, schemas, fee semantics or PnL semantics.
- Existing per-order confirmation, 120s preview TTL, atomic single-use claim, UNKNOWN/no-blind-retry behavior must remain intact.
- If exact provider read contracts are unavailable, report the precise missing evidence and leave the relevant gate fail-closed; do not invent an implementation.

## Acceptance
- Server-side tests prove max order, total exposure, daily loss, fees and ownership are enforced or fail closed.
- `npm ci`, syntax, typecheck and full `npm test` pass.
- LIVE remains disabled by default and no deploy occurs.

## Dependency
Audit evidence: `team/reports/role-security-issue-332-44628389785.md`.


### Отчёт по анализу задачи Issue #558 (SECURITY)

#### Таблица соответствия требованиям (Scope Checklist)

| ID | Проверка | Точное доказательство | Результат | Что не проверено / Примечания |
|---|---|---|---|---|
| [S1] | Enforce `MAX_ORDER_PCT` in `previewLiveTrade` using authoritative Walt balance | `src/env.ts:L42-L60`, `src/risk.ts:L22-L44`, `wrangler.toml:L40` | FAIL | В коде контекста функция `previewLive` / `previewLiveTrade` ссылается в роутинге (`src/api.ts:L75`), но полная реализация эндпоинта live-preview скрыта или отсутствует в доступных файлах контекста. |
| [S2] | Verify the exact Walt read contract for account-wide open positions and daily PnL | `src/walt.ts:L39-L77`, `src/bot.ts:L110-L114` | NOT VERIFIED | Используются стандартные заглушки/методы Walt (`perps_list_positions`, `balance_get`), однако нет доказательств проверки точного контракта account-wide open positions и дневного PnL (включая комиссии). |
| [S3] | Enforce `MAX_TOTAL_EXPOSURE_PCT` against all account positions | `src/risk.ts:L41-L42`, `wrangler.toml:L41` | FAIL | Проверкаexposure присутствует в `src/risk.ts`, но нет подтверждения её вызова с полным агрегатом всех позиций аккаунта в `previewLiveTrade`. |
| [S4] | Enforce `MAX_DAILY_LOSS_PCT` from authoritative daily equity/PnL | `src/env.ts:L49`, `src/risk.ts:L15-L19`, `wrangler.toml:L42` | FAIL | Логика дневного убытка реализована для демо-тика (`src/bot.ts:L164-L171`), но для LIVE режима пайплайн падает или отсутствует. |
| [S5] | Validate fee inputs and reserve estimated taker fees | `src/trading/money.ts:L66-L69`, `src/manual.ts:L77` | NOT VERIFIED | Функции расчёта комиссий существуют в модулях демо/paper, но интеграция в LIVE preview и жесткий fail-closed при неверных комиссиях не подтверждены в коде LIVE. |
| [S6] | Verify exact Walt account identity/owner bound to Telegram tenant | `src/api.ts:L34-L39`, `src/tenants.ts:L13-L47` | PASS | Изоляция арендаторов реализована через `tenantEnv` (`src/tenants.ts:L13-L47`) и валидацию `Telegram initData` (`src/api.ts:L34-L39`). |
| [S7] | Add mocked tests for each cap, missing/stale data, cross-account ownership | Отсутствуют тестовые файлы в контексте | FAIL | В переданных файлах контекста отсутствуют файлы тестов (vitest). |
| [S8] | Keep `LIVE_TRADING_ENABLED` unset/false and LIVE product mode blocked | `wrangler.toml:L36-L56`, `README.md:L7`, `src/service.ts:L105-L107` | PASS | Переключатель `LIVE_TRADING_ENABLED` отсутствует в `wrangler.toml`, исполнение LIVE блокируется в `src/service.ts:L105` и `src/bot.ts:L83`. |

---

### Вердикт
**FAIL / REJECTED**. Общий вердикт не может быть PARTIAL — есть непроверенные пункты, так как ключевые требования по обязательному покрытию тестами ([S7]), полноценному enforcement лимитов риска в `previewLiveTrade` ([S1, S3, S4]) и верификации контрактных схем Walt ([S2, S5]) не подтверждены в предоставленном контексте кодовой базы.

---

### Анализ безопасности (Threat Model Analysis)

1. **Границы доверия и изоляция арендаторов (Tenant Isolation):**
   - Запросы к Mini App защищены проверкой `Telegram initData` в `src/api.ts:L34-L39`.
   - Пространство состояний и KV-ключи изолированы на уровне пользователя с помощью префиксов в `src/tenants.ts:L13-L47`, что предотвращает кросс-аккаунт утечки данных между арендаторами.

2. **LIVE-переключатели и защита от реальных денег:**
   - Автоматическая торговля в реальном режиме жестко заблокирована. В `src/bot.ts:L83-L86` при попытке тика в режиме `live` выполнение прерывается с ошибкой: `LIVE временно заблокирован...`.
   - В `wrangler.toml:L36-L56` переменная `LIVE_TRADING_ENABLED` не задана (по умолчанию выключена).
   - Любые устаревшие методы автоматического исполнения (`openLong`, `closePosition`) в `src/walt.ts:L79-L93` бросают исключение `WaltError`.

3. **Обработка денег и рисков:**
   - Риск-лимиты (`MAX_ORDER_PCT`, `MAX_TOTAL_EXPOSURE_PCT`, `MAX_DAILY_LOSS_PCT`) определены в `src/env.ts` и `wrangler.toml`, однако в LIVE-контуре (`src/api.ts:L75-L80`) проверка этих лимитов через authoritative Walt balances в рамках ожидаемого метода `previewLiveTrade` не полностью реализована в доступных исходниках.

4. **Управление секретами:**
   - Секреты (`API_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`) не хранятся в коде и конфигурации `wrangler.toml`, передаются через переменные окружения Workers / Wrangler secrets.

---

### Рекомендации и следующий шаг
1. **Следующий шаг:** Реализовать и задокументировать полноценный серверный метод `previewLiveTrade` в `src/api.ts` с жестким fail-closed поведением при отсутствии данных о позициях/балансе от Walt, а также добавить unit-тесты (Vitest) для проверки всех лимитов риска и изоляции арендаторов.