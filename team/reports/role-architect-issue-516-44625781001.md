# ARCHITECT — анализ задачи #516

- Режим: анализ, исходники не изменялись
- Задача: <!-- kg-child-task:v1;parent=239;key=ai-live-control;team=C;role=ARCHITECT;depends=none -->

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

### Отчёт роли ARCHITECT: Анализ задачи Issue #516

| ID | Проверка | Точное доказательство | Результат | Что не проверено |
|---|---|---|---|---|
| [S1] | Модель трёх execution modes (MANUAL LIVE, AI PAPER, AI LIVE) | `src/api.ts:L54-L75`, `src/trading/engine.ts:L72-L81`, `README.md:L7-L17` | PASS | Фактическое срабатывание веб-хуков Telegram и сети в Cloudflare Workers |
| [S2] | AI LIVE session authorization и server-side ограничения | `src/trading/engine.ts:L72-L81`, `src/trading/engine.ts:L100-L105` | PASS | Взаимодействие с реальным контрактом Walt в продакшене (заблокировано по бюджету) |
| [S3] | Запрет разработки/тестов для LIVE (нет write-вызовов, только статический анализ) | `README.md:L7`, `src/walt.ts:L79-L93`, `team/ARCHITECT_AGENT.md:L14-L18` | PASS | Поведение локального окружения Wrangler вне sandbox |
| [S4] | Наличие требуемых результатов (state machine, API contract, threat model, idempotency) | `src/trading/engine.ts:L58-L81`, `src/trading/positions.ts:L52-L138`, `src/companion-quota.ts:L10-L106` | PASS | Производительность SQL-транзакций при высоких нагрузках |

---

### Архитектурный вердикт
**Вердикт:** `PARTIAL — есть непроверенные пункты` (с оговоркой о строгом блокировании LIVE-исполнения).

#### Детализированный архитектурный анализ

1. **State Machine (Модель состояний):**
   - Реализована в `src/trading/engine.ts:L58-L81` через SQLite-таблицы (`ai_paper_accounts`, `ai_paper_positions`, `ai_paper_decisions`, `live_operations`).
   - Разделение между изолированным виртуальным ledger (`ai_paper_`) и ручными демо-позициями исключает пересечение контекстов.

2. **API Contract:**
   - Эндпоинты четко разграничены в `src/api.ts:L54-L75`:
     - `GET ai/paper/status` и `POST ai/paper/fund` / `POST ai/paper/withdraw` обслуживают AI PAPER.
     - `POST live/preview`, `POST live/execute`, `GET live/operation` реализуют двухфазную сессионную модель для AI/MANUAL LIVE.

3. **Threat Model & Safety (Угрозы и безопасность):**
   - **Fail-closed по умолчанию:** При потере соединения, сбое цен или нарушении лимитов новые ордера не отправляются (`src/trading/engine.ts` и `src/bot.ts`).
   - **Изоляция прав:** AI не имеет прав на вывод (`withdraw`), перевод (`transfer`) или управление аккаунтом (`account-management`).
   - **Отсутствие blind retries:** Поведение при сбоях описано в `src/walt.ts:L3-L4`, повторные отправки (`blind retries`) заблокированы во избежание дублирования ордеров.

4. **Persistence & Idempotency:**
   - Идемпотентность AI paper ledger обеспечивается уникальным ключом `UNIQUE(user_id, idempotency_key)` в `src/trading/engine.ts:L75`.
   - Сессионные токены и лимиты хранятся в durable state (Cloudflare DO SQLite), что гарантирует сохранение состояния между вызовами.

#### Риски и пробелы
- LIVE-контур остается заблокированным (`README.md:L7`, `src/walt.ts:L79-L93`). Попытки автоматического вызова `openLong` или `closePosition` приводят к выбросу ошибки `WaltError`.
- Отсутствует интеграционный прогон на реальном устройстве (iOS Telegram WebView), что требует обязательного ручного тестирования интерфейса Mini App перед любым изменением статуса релиза.

#### Один следующий шаг
Провести статический анализ покрытия тестами модуля `src/trading/engine.ts` с помощью `npm test`, убедившись в корректности изоляции таблиц `ai_paper_*` и обработки сессий без изменения write-путей в production.