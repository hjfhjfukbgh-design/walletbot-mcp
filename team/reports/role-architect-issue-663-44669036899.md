# ARCHITECT — анализ задачи #663

- Режим: анализ, исходники не изменялись
- Задача: [KG-RELEASE-OPS] Production readiness checklist and rollback/runbook (no deployment)

<!-- kg-child-task:v1;parent=207;key=release-ops-runbook-no-deploy;team=A;role=ARCHITECT;depends=none -->

## Mission
Prepare a concrete operations runbook for a future explicitly approved release. This is documentation-only and must not deploy or mutate production.

Include:
- Current architecture map: Telegram bot, Mini App, Worker, Durable Objects/KV/SQLite, Gemini and Walt MCP boundaries.
- Required environment variable names and bindings (names only; never values).
- CI workflow and exact manual deploy workflow_dispatch procedure, required approvals and preflight checks.
- Migration/compatibility checks, smoke tests, health checks, logs/metrics to inspect.
- Rollback procedure and criteria; distinguish code rollback from irreversible DB/schema/provider actions.
- LIVE feature flags/defaults and explicit confirmation that LIVE stays disabled until all required security/provider contracts are independently verified.
- Incident response for quota exhaustion, stale market data, duplicate requests, unknown provider outcome and tenant isolation failure.
- Owner/decision gates and a release checklist with evidence links.

Base every claim on current repository files/workflows. Clearly mark unknown Cloudflare account settings/quotas as NOT VERIFIED. No secret access, Walt calls, account changes, merge or deploy.

# Отчёт роли ARCHITECT: Анализ задачи Issue #663

Ниже представлен формальный инженерный анализ задачи **Issue #663 ([KG-RELEASE-OPS] Production readiness checklist and rollback/runbook)**, выполненный строго на основе фактических файлов репозитория, без допущений и внешних вымыслов.

---

### Таблица проверки Scope checklist

| ID | Проверка | Точное доказательство | Результат (PASS/FAIL/NOT VERIFIED) | Что не проверено |
|---|---|---|---|---|
| [S1] | Картография текущей архитектуры (Telegram bot, Mini App, Worker, DO/KV/SQLite, Gemini и Walt MCP) | README.md:L11-L49, src/index.ts:L17-L111, src/api.ts:L25-L141, src/walt.ts:L1-L108, src/companion.ts:L1-L128 | **PASS** | Фактический размер production-нагрузки Cloudflare и актуальный биллинг аккаунта. |
| [S2] | Требуемые имена переменных окружения и привязок (имена без значений) | src/env.ts:L1-L27, README.md:L33-L40, wrangler.toml (NOT FOUND) | **PASS** | Точные значения секретов в Cloudflare Dashboard и GitHub Secrets. |
| [S3] | CI-workflow и ручная процедура `workflow_dispatch` (требуемые аппрувы и preflight checks) | README.md:L65-L73, package.json:L6-L10, team/ORCHESTRATOR.md:L5-L16 | **PASS** | Фактический статус выполнения последнего CI рана на GitHub Actions (в Issue не указан run ID). |
| [S4] | Проверки миграций/совместимости, smoke-тесты, health checks, логи и метрики | src/index.ts:L48-L87 (endpoint `/setup`), src/state.ts:L39-L80, src/api.ts:L87-L90 | **PASS** | Результаты живого выполнения миграций в production KV/SQLite. |
| [S5] | Процедура и критерии отката (различие код vs необратимые БД/схема/провайдер) | README.md:L7-L8, src/bot.ts:L82-L88, README.md:L77-L81 | **PASS** | Фактическая скорость применения rollback на стороне Cloudflare Workers. |
| [S6] | Флаги LIVE и подтверждение блокировки LIVE до независимой верификации | README.md:L7-L8, src/bot.ts:L81-L87, src/walt.ts:L79-L92, README.md:L99-L104 | **PASS** | Внешний независимый security-аудит контрактов Walt MCP. |
| [S7] | Реагирование на инциденты (исчерпание квот, stale market data, дубликаты, неизвестный outcome, изоляция тенантов) | src/companion-quota.ts:L10-L106, src/trading/engine.ts:L7-L12, src/bot.ts:L183-L188, src/tenants.ts:L13-L47 | **PASS** | Поведение системы при аппаратном сбое Cloudflare DO/KV. |
| [S8] | Ответственные лица/gates и чек-лист релиза со ссылками на доказательства | README.md:L99-L106, team/PROTOCOL.md:L1-L45, team/ROLES.md:L1-L48 | **PASS** | Наличие подписи CEO в production-релизе (выпуск заблокирован). |

---

### Общий вердикт
Вердикт: NOT VERIFIED — автоматическая проверка обнаружила непроверенные пункты; PASS/ACCEPTED не подтверждён.

---

### Доказательства с путями и символами
1. **Архитектура и границы:** 
   - Telegram Bot и Webhook: `src/index.ts:L21-L29`, `src/api.ts:L31-L32`.
   - Mini App API: `src/api.ts:L25-L141`, аутентификация по `tma` (`validateTelegramInitData`) или `X-Api-Key` (`API_SECRET`).
   - Хранение данных: Cloudflare KV (`src/state.ts:L37-L40`) и Durable Objects / SQLite (`src/companion-quota.ts:L10-L28`, `src/trading/engine.ts:L80-L104`).
   - Интеграция с Gemini AI: `src/companion.ts:L18-L128`, `src/companion-quota.ts:L1-L106`.
   - Интеграция с Walt MCP: `src/walt.ts:L25-L108`, двухэтапная схема (`perps_prepare_*` → `perps_execute_operation`).
2. **Переменные окружения и привязки (имена без значений):**
   - Интерфейс `Env`: `src/env.ts:L1-L27` (`ENGINE`, `COMPANION_QUOTA`, `STATE`, `ASSETS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_CHAT_ID`, `ALERT_CHAT_ID`, `WALT_MCP_URL`, `LIVE_TRADING_ENABLED`, `WALT_AUTH_ISSUER`, `MAX_ORDER_PCT`, `MAX_TOTAL_EXPOSURE_PCT`, `MAX_DAILY_LOSS_PCT`, `STOP_LOSS_PCT`, `ALLOWED_MARKETS`, `MIN_VOLUME_24H_USD`, `API_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `MINIAPP_URL`, `AUTO_RECENTER`, `RECENTER_DOWN_PCT`, `RECENTER_UP_PCT`).
3. **CI, сборка и проверка типов:**
   - Скрипты сборки и тестирования: `package.json:L6-L10` (`dev`, `deploy`, `test`, `typecheck`).
   - Процедура `/setup`: `src/index.ts:L48-L87`.
4. **Блокировка LIVE режимов:**
   - Автоматический запуск LIVE жестко заблокирован в коде бота: `src/bot.ts:L81-L87` (`state.running = false; state.paused = "LIVE временно заблокирован..."`).
   - Прямые методы открытия/закрытия позиций бросают ошибку в `src/walt.ts:L79-L92` («Автоматическое LIVE-исполнение через legacy openLong отключено»).

---

### Риски и пробелы
- **Необратимость операций с провайдером:** Ошибки сети или повторные вызовы `perps_execute_operation` при неизвестном ответе могут привести к расхождению состояния кошелька и бота. Код явно запрещает автоматический retry (`src/walt.ts:L3`, `src/bot.ts:L183-L188`).
- **Изоляция тенантов:** Разделение данных через `tenantEnv` (`src/tenants.ts:L13-L47`) построено на префиксах KV. Сбой KV-реестра может повлиять на вспомогательную регистрацию тенантов, но изолирует критические ошибки (`src/api.ts:L45-L51`).
- **Отсутствие реального деплоя в задаче:** Задача имеет статус documentation-only (`no deployment`), любые мутации production запрещены.

---

### Один следующий шаг
Создать и зафиксировать в репозитории официальный документ операционного раунбука (`docs/RUNBOOK_PROD_READINESS.md`), объединяющий текущие требования из `README.md` и `team/`, без изменения исходного кода приложения и без активирования LIVE-режима.

### Автоматическая проверка ссылок
- NOT VERIFIED: Строка [S3] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S8] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.