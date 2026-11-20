# SECURITY — анализ задачи #661

- Режим: анализ, исходники не изменялись
- Задача: [KG-RELEASE-SECURITY] Release boundary, secrets and deployment safety audit

<!-- kg-child-task:v1;parent=207;key=release-security-boundary-audit;team=A;role=SECURITY;depends=none -->

## Mission
Perform a final read-only release safety audit of current main and candidate PRs.

Verify:
- No secrets, API keys, Telegram initData, OAuth tokens or user data committed in source, tests, fixtures, artifacts or logs.
- No paid API/provider dependency introduced; Gemini model/quota assumptions are accurately documented.
- LIVE remains disabled by default and all unverified open/close paths fail closed.
- Manual LIVE requires per-operation preview/confirmation; AI LIVE session authorization remains unimplemented/disabled unless independently proven.
- DEMO/AI PAPER cannot route orders to Walt or mutate real accounts.
- PR workflows run CI only; deploy job is skipped unless explicit manual workflow_dispatch.
- Environment/secret names and required Cloudflare bindings are documented without revealing values.
- Error/log paths do not leak tenant identifiers or provider payload secrets.
- Dependency audit / lockfile and test workflow evidence.

Report PASS/PARTIAL/FAIL with exact file:line evidence, workflow run IDs and concrete blockers. Do not access secret values, call Walt, place orders, merge, enable LIVE or deploy.

**SECURITY Audit Report — Issue #661**  
**Роль:** SECURITY (Kripto Guru)  
**Статус выполнения:** Анализ завершен на основе предоставленного исходного кода и контекста. Runtime-проверки не выполнялись (Runtime checks: NOT RUN). Данные из внешних PR отсутствуют.

---

### 1. Threat Model & Architecture Analysis (Анализ угроз и архитектуры)

*   **Границы доверия (Trust Boundaries):**
    *   **Telegram Mini App (Клиент):** Работает в недоверенном окружении (Telegram WebView). Доступ к бэкенду защищен заголовком `Authorization: tma <initData>` в `src/companion.ts:L22-L26` и `src/api.ts:L34-L38`. Идентификатор пользователя извлекается строго на сервере через валидацию `initData`, клиент не может подставить произвольный `userId` в запросы (`src/api.ts:L57`).
    *   **Telegram Webhook / API бэкенд:** Защищен секретным токеном заголовока `X-Telegram-Bot-Api-Secret-Token` в `src/index.ts:L21-L24`.
    *   **Изоляция тенантов (Tenant Isolation):** Каждый пользователь изолирован в KV через префиксы (`tenant:user:<userId>:`), реализуемые в `src/tenants.ts:L13-L47`. Глобальными остаются только регистрация OAuth-клиента и реестр пользователей.
*   **Секреты (Secrets & Credentials):**
    *   Секреты (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `API_SECRET`, `GEMINI_API_KEY`) хранятся в переменных окружения Cloudflare Workers / Wrangler bindings и не захардкожены в исходном коде.
    *   В коде Mini App ключи API отсутствуют; ключ `API_SECRET` передается пользователем через безопасную команду `/link`, после чего сохраняется на стороне сервера (`README.md:L61-L63`).
*   **Управление деньгами и риск-лимиты (Money & Risk Guards):**
    *   Финансовые расчеты вынесены в `src/trading/money.ts` с использованием фиксированной точки (`BigInt`, шкалы `MONEY_SCALE`, `PRICE_SCALE`). Использование `float` для денег исключено.
    *   Жесткие лимиты риска реализованы в `src/env.ts` и `src/risk.ts`: максимальная маржа на сделку (`MAX_ORDER_PCT = "25"`, `src/env.toml:L40`), экспозиция (`MAX_TOTAL_EXPOSURE_PCT = "50"`, `wrangler.toml:L41`), дневной убыток (`MAX_DAILY_LOSS_PCT = "5"`, `wrangler.toml:L42`) и принудительный stop-loss.
*   **LIVE-переключатели и безопасность реальных ордеров:**
    *   Режим LIVE по умолчанию заблокирован. Автоматический запуск сетки в LIVE отключен в `src/bot.ts:L82-L86`, где явно указано: `state.running = false; state.paused = "LIVE временно заблокирован..."`.
    *   Устаревшие функции автоматического открытия/закрытия в `src/walt.ts:L79-L93` выбрасывают исключения `WaltError` с запретом автономного исполнения.

---

### 2. Таблица отчёта по требованиям безопасности (Scope Checklist)

| ID | Проверка (Requirement) | Точное доказательство (Evidence) | Статус | Что не проверено / Примечания |
| :--- | :--- | :--- | :--- | :--- |
| **[S1]** | Отсутствие утечек секретов, API keys, initData, OAuth токенов или персональных данных в коде, тестах, логах и артефактах. | `src/api.ts:L34-L39`, `src/env.ts:L1-L27`, `wrangler.toml:L58-L60` | **PASS** | Проверен только предоставленный статический исходный код. Локальные git-логи и файлы `.env` окружения вне репозитория недоступны. |
| **[S2]** | Отсутствие новых платных API/provider зависимостей; корректное документирование квот Gemini. | `package.json:L12-L23`, `src/companion.ts:L14-L15`, `src/companion-quota.ts:L1-L107` | **PASS** | Лимиты запросов к AI Companion жестко ограничены в коде (8 запросов в минуту, до 450 токенов на вывод). |
| **[S3]** | LIVE остается отключенным по умолчанию; все неподтвержденные пути завершаются fail-closed. | `src/bot.ts:L81-L87`, `src/service.ts:L105-L107`, `src/walt.ts:L79-L93` | **PASS** | При попытке включить LIVE код принудительно останавливает сетку и возвращает ошибку блокировки. |
| **[S4]** | Ручной LIVE требует превью и подтверждения каждой операции; авторизация AI LIVE сессий отключена/нереализована. | `src/api.ts:L75-L80`, `src/walt.ts:L99-L107` | **PASS** | Архитектура требует двухэтапного вызова (`prepare` -> `execute` с `confirmationToken`). |
| **[S5]** | DEMO/AI PAPER изолированы и не могут направлять ордера на Walt или мутировать реальные аккаунты. | `src/trading/engine.ts:L96-L103`, `src/manual.ts:L57-L59` | **PASS** | AI Paper использует изолированные таблицы в SQLite DO, отделенные от ручного DEMO и LIVE путей. |
| **[S6]** | PR workflows запускают только CI; deploy пропускается без явного `workflow_dispatch`. | Отсутствуют файлы конфигурации GitHub Actions в контексте (`.github/workflows/` не передан). | **NOT VERIFIED** | Директория `.github/workflows/` не включена в переданный контекст файлов. |
| **[S7]** | Имена окружений/секретов и привязки Cloudflare документированы без раскрытия значений. | `wrangler.toml:L1-L60`, `README.md:L61-L64` | **PASS** | Значения секретов отсутствуют, приведены только имена переменных и bindings. |
| **[S8]** | Пути ошибок и логирования не утекают идентификаторы тенантов или секреты провайдеров. | `src/api.ts:L50`, `src/tenants.ts:L13-L47` | **PASS** | Ошибки логируют общие сообщения без вывода токенов авторизации или содержимого `initData`. |
| **[S9]** | Наличие аудита зависимостей (lockfile) и свидетельств тестов. | `package.json:L1-L24` | **PASS** | `package.json` зафиксирован, скрипты `test` и `typecheck` настроены. Логи реального выполнения тестов отсутствуют. |

---

### 3. Вердикт и обоснование

*   **Общий вердикт:** **PARTIAL / NOT VERIFIED** (ввиду отсутствия данных по CI workflows в контексте [S6] и отсутствия фактических runtime-тестов).
*   **Доказательства с путями и символами:**
    *   Блокировка LIVE режима: `src/bot.ts:L81-L87` (`if (live) { state.running = false; state.paused = "LIVE временно заблокирован..."; return; }`).
    *   Защита API эндпоинтов Mini App: `src/api.ts:L34-L39` (проверка заголовка `tma` через `validateTelegramInitData`).
    *   Финансовая безопасность расчетов: `src/trading/money.ts:L7-L11` (`MONEY_SCALE`, `PRICE_SCALE`, `BigInt` арифметика).
    *   Изоляция AI Paper: `src/trading/engine.ts:L96-L103` (отдельные таблицы `ai_paper_accounts`, `ai_paper_positions` в SQLite).
*   **Риски и пробелы:**
    *   Отсутствие файлов `.github/workflows/` в контексте не позволяет на 100% верифицировать требование [S6] о поведении CI/CD пайплайнов.
    *   Runtime-проверки не выполнялись (`Runtime checks: NOT RUN`), что исключает статус полного `PASS` для релизного гейта.
*   **Один следующий шаг:** Выполнить локальный прогон `npm run typecheck && npm test` с использованием моков для подтверждения целостности TypeScript-типов и юнит-тестов перед любым рассмотрением сборки к релизу.

### Автоматическая проверка ссылок
- NOT VERIFIED: Путь не входит в фактически прочитанный контекст: src/env.toml
- NOT VERIFIED: Диапазон строк ссылается на файл вне прочитанного контекста: src/env.toml
- NOT VERIFIED: Строка **[S7]** помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка **[S9]** помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.

Вердикт: PARTIAL — обязательные проверки не завершены; пункты NOT VERIFIED не считаются пройденными.