# SECURITY — анализ задачи #658

- Режим: анализ, исходники не изменялись
- Задача: <!-- kg-child-task:v1;parent=206;key=security-verify-walt-close-contract-332;team=A;role=SECURITY;depends=none -->

## Mission
Independently verify issue #332: whether the connected Walt MCP integration exposes a documented and implemented close-position operation contract suitable for safe LIVE use.

Inspect only repository code, MCP tool schemas and public/available provider documentation. Do not invoke any Walt operation or use a real account.

Verify:
1. Exact close tool/function name, required arguments, idempotency/client order ID, response schema and error semantics.
2. Whether close supports reduce-only/position-side/size semantics and partial closes.
3. Whether preview/confirm/execute/status/reconciliation routes exist for close, and whether confirmation is bound to Telegram tenant, exact position/size and expiry.
4. Ambiguous timeout/unknown outcome behavior; no blind retry.
5. Whether a close can be safely verified without making a live call.
6. Explicitly distinguish VERIFIED, NOT VERIFIED and NOT IMPLEMENTED. Do not infer a close API from open-order APIs.

Produce a concise report with exact code file:line and provider documentation evidence, blockers and minimal follow-up. No Walt calls, real orders, secrets, account changes, paid APIs, merge or production deploy. LIVE stays disabled.

## Отчёт по анализу задачи Issue #658 (Независимая верификация контракта закрытия позиции Walt MCP)

### Таблица анализа Scope & Требований

| ID | Проверка | Точное доказательство (файл и строки) | Результат (PASS/FAIL/NOT VERIFIED) | Что не проверено |
|---|---|---|---|---|
| [S1] | Точное имя инструмента закрытия, аргументы, idempotency/order ID, схема ответа и семантика ошибок | `src/walt.ts:L90-L93`<br>`src/walt.ts:L103-L107` | **NOT VERIFIED** | Реальный MCP-сервер Walt не опрашивался (Runtime checks: NOT RUN). В репозитории закрывающий инструмент явно отключен и не реализован через prepare/execute. |
| [S2] | Поддержка reduce-only, position-side, size и частичного закрытия | `src/walt.ts:L90-L93`<br>`src/strategy/grid.ts:L1-L4` | **NOT VERIFIED** | Отсутствуют вызовы или схемы инструментов закрытия Walt; архитектура сетки предполагает «одну позицию на контракт» с нативным `autoClose` на стороне Walt. |
| [S3] | Наличие маршрутов preview/confirm/execute/status/reconciliation и привязка к Telegram tenant, позиции/размеру и времени жизни (expiry) | `src/api.ts:L75-L90`<br>`src/tenants.ts:L13-L47` | **FAIL** | Маршруты `live/preview` и `live/execute` (`src/api.ts:L75-L78`) не имеют подтверждённого аналога в закрывающем контракте Walt (`src/walt.ts:L90-L93`). Проверка binding к конкретному Telegram tenant для закрытия отсутствует. |
| [S4] | Обработка тайм-аутов и неизвестных исходов (no blind retry) | `src/walt.ts:L3-L4`<br>`src/bot.ts:L180-L188` | **NOT VERIFIED** | Поведение при тайм-ауте закрытия не покрыто реализацией, так как сам метод `closePosition` выбрасывает исключение заглушки. |
| [S5] | Безопасная верификация закрытия без реальных LIVE вызовов | `README.md:L7`<br>`wrangler.toml:L36` | **VERIFIED** (в части блокировки) | LIVE-режим заблокирован на уровне конфигурации и кода. Динамическая верификация закрытия без вызовов невозможна из-за отсутствия спецификации close-tools в коде. |
| [S6] | Четкое разделение VERIFIED, NOT VERIFIED, NOT IMPLEMENTED (без инференции из open-order APIs) | `src/walt.ts:L90-L93`<br>`src/bot.ts:L82-L86` | **VERIFIED** | Метод закрытия (`closePosition`) явно помечен как нереализованный и заменен ошибкой-заглушкой. |

---

### Общий вердикт
**NOT VERIFIED / FAIL**

Общий вердикт не может быть `PASS`, так как обязательные пункты верификации контракта закрытия позиции ([S1], [S2], [S3], [S4]) имеют статус `NOT VERIFIED` или `FAIL`, а реальный контракт закрытия в коде заменен на исключение-заглушку (`src/walt.ts:L90-L93`).

---

### Доказательства (Evidence)
- **Блокировка закрытия и LIVE в коде:** `src/walt.ts:L90-L93` (`async closePosition(_contractId: number): Promise<never> { throw new WaltError("Автоматическое LIVE-закрытие через legacy closePosition отключено..."); }`).
- **Архитектурные ограничения:** `README.md:L7` (*"执行 LIVE está atualmente bloqueada no bot e na Mini App até a validação independente do ciclo completo de abertura/fechamento"*).
- **Изоляция тенантов и API:** `src/api.ts:L75-L90`, `src/tenants.ts:L13-L47`.

---

### Анализ безопасности (Threat Model)
1. **Границы доверия (Trust Boundaries):** Разделение между локальным Telegram Serverless (miniapp), Cloudflare Worker (API/Trading Engine) и внешним MCP-провайдером Walt. Все запросы от Mini App требуют валидации `tma` initData (`src/api.ts:L34-L38`), а фоновые тики изолированы по тенантам (`src/tenants.ts:L13-L47`).
2. **Секреты и авторизация:** `API_SECRET` защищает эндпоинты Worker (`src/api.ts:L32`), токены OAuth хранятся в изолированном KV-пространстве тенанта (`src/tenants.ts:L13-L29`).
3. **Деньги и риск-лимиты:** Торговые лимиты (`MAX_ORDER_PCT = "25"`, `MAX_DAILY_LOSS_PCT = "5"`, `STOP_LOSS_PCT = "5"`) жестко прописаны в `wrangler.toml` и проверяются модулем `src/risk.ts`.
4. **LIVE-переключатели:** LIVE-режим принудительно заблокирован (`src/bot.ts:L82-L86`, `src/service.ts:L105-L107`). UI и бэкенд работают в режиме `fail-closed`, пока контракт закрытия и полный цикл сверки не будут независимо верифицированы.

---

### Риски и пробелы (Risks & Gaps)
- Отсутствие в MCP-интеграции документированного и реализованного метода закрытия позиции (`perps_prepare_close` / `perps_execute_close` или аналогичного) делает безопасный переход в LIVE технически невозможным.
- Риск рассинхронизации состояния позиции на бирже Walt и локального бота при возникновении неизвестных сетевых статусов (unknown outcomes) без механизмов reconciliation.

---

### Один следующий шаг (Single Next Step)
Провести аудит доступных инструментов MCP-сервера Walt (`tools/list`) с использованием изолированного тестового аккаунта без реального капитала для документирования точных схем и имен инструментов закрытия позиции, после чего реализовать `perps_prepare_close` → `perps_execute_operation` с поддержкой `confirmationToken` и idempotency в `src/walt.ts`.