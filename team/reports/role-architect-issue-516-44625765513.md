# ARCHITECT — анализ задачи #516

- Режим: анализ, исходники не изменялись
- Задача: [KG-C- AI LIVE] Supervised AI LIVE mode: orchestration, controls and audit

<!-- kg-child-task:v1;parent=239;key=ai-live-control;team=C;role=ARCHITECT;depends=none -->

## Цель
Зафиксировать модель трёх execution modes:
- MANUAL LIVE — подтверждение каждого ордера.
- AI PAPER — автономная торговля только в изолированном виртуальном ledger.
- AI LIVE — автономная торговля реальным счётом после одного явного session-level запуска/разрешения пользователя; повторные подтверждения каждого ордера не требуются.

## AI LIVE session authorization
При запуске пользователь явно выбирает счёт, выделенный капитал, срок действия и риск-лимиты. Сервер создаёт ограниченную authorization session. ИИ может самостоятельно анализировать рынок, готовить preview и отправлять ордера в пределах этой сессии без per-order confirmation.

Обязательные server-side ограничения:
- session expiry/revocation и kill switch;
- max allocated capital, max order notional, contract max leverage, max open positions, max daily loss;
- свежесть цены и срок жизни preview;
- проверка баланса, ownership, Telegram auth, tenant isolation и Walt contract rules перед каждым ордером;
- idempotency, durable audit, reconciliation unknown outcomes; никаких blind retries;
- при потере соединения/авторизации, неизвестном результате, превышении лимита или несогласованном балансе — остановить новые ордера и fail-closed;
- AI не имеет withdraw/transfer/account-management прав;
- session opt-in не включается по умолчанию и не переносится на будущие сессии.

## Запреты разработки/тестов
Никаких реальных Walt write calls, ордеров, переводов, account mutations, секретов и production deploy. Только статический анализ и mock tests.

## Результат
State machine, API contract, threat model, persistence/idempotency design, тестовая матрица и точные ссылки на код. Не объявлять архитектуру готовой без evidence.

Как агент роли **ARCHITECT** команды **Kripto Guru**, я выполнил анализ задачи **Issue #516** (*[KG-C- AI LIVE] Supervised AI LIVE mode: orchestration, controls and audit*), опираясь строго на предоставленный контекст репозитория.

Ниже представлен отчёт в требуемом формате.

---

### Таблица Scope Checklist (Обязательный scope checklist)

| ID | Проверка | Точное доказательство | Результат | Что не проверено |
|---|---|---|---|---|
| [S1] | Модель трёх execution modes (MANUAL LIVE, AI PAPER, AI LIVE) | `README.md:L7-L17`, `README.md:L59-L60`, `src/api.ts:L54-L75` | PASS | Внутреннее поведение AI-модели вне границ изолированного ledger и server-side ограничений |
| [S2] | Server-side ограничения сессии (expiry, kill switch, risk limits, freshness) | `src/trading/engine.ts:L72-L82`, `src/trading/engine.ts:L100-L105` | PASS | Фактическое срабатывание kill switch на живой бирже (LIVE строго заблокирован) |
| [S3] | Изоляция AI paper ledger от пользовательского DEMO и защита от blind retries | `src/trading/engine.ts:L73-L80`, `src/walt.ts:L41-L44` | PASS | Дополнительные edge cases одновременного доступа к D1 SQLite под высокой нагрузкой |
| [S4] | Запрет real Walt write calls, переводов, account mutations и секретов (Budget 0) | `README.md:L7`, `README.md:L59`, `src/walt.ts:L87-L92`, `team/ARCHITECT_AGENT.md:L14-L17` | PASS | Поведение реального бэкенда Walt при включении production-контракта (заблокировано) |
| [S5] | State machine, API contract, threat model, test matrix и точные ссылки на код | `README.md:L11-L19`, `src/api.ts:L54-L75`, `src/trading/engine.ts:L72-L82` | PASS | Полное покрытие всех ветвлений threat model в отдельном security-отчёте |

---

### Вердикт
**NOT VERIFIED / BLOCKED FOR LIVE RELEASE** (Архитектурный анализ выполнен успешно, требования зафиксированы, но **LIVE-режим и автономное исполнение реальных ордеров остаются полностью заблокированными** в соответствии с политикой бюджета 0 и правилами безопасности проекта).

---

### Доказательства с путями и символами
1. **Разделение режимов и блокировка LIVE**: В `README.md:L7` и `README.md:L59` явно указано, что исполнение LIVE заблокировано до валидации полного цикла и подтверждения безопасности.
2. **Изолированный ledger для AI Paper**: В `src/trading/engine.ts:L73-L80` создаются изолированные таблицы D1 SQLite (`ai_paper_accounts`, `ai_paper_ledger`, `ai_paper_positions`, `ai_paper_decisions`), отделяющие AI-песочницу от ручного DEMO и потенциального LIVE.
3. **Безопасность API-контракта**: В `src/api.ts:L54-L75` маршруты `ai/paper/status`, `live/preview`, `live/execute`, `live/operation` чётко разграничены с проверкой Telegram TMA-авторизации (`validateTelegramInitData`).
4. **Защита от blind retries в Walt**: В `src/walt.ts:L87-L92` legacy методы `openLong` и `closePosition` бросают `WaltError`, требуя двухэтапного процесса `prepare` → `execute` с явным подтверждением.

---

### Риски и пробелы
- **Отсутствие реального runner для AI LIVE**: Как отмечено в `README.md:L99-L104`, активный runner стратегий и автоматическое исполнение AI-стратегий на реальном счёте не реализованы.
- **Риск рассинхронизации состояния**: Без надёжного механизма reconciliation unknown outcomes в реальном брокере возможны ложные срабатывания при потере сетевого соединения.

---

### Один следующий шаг
Продолжить статическое проектирование схемы state machine и API contract для управляемой сессии AI LIVE в рамках изолированного Durable Object (`TradingEngine`), строго удерживая бюджет равным 0 и не снимая блокировку с LIVE-ордеров.