# SECURITY — перепроверенный статический аудит Issue #278

- **Режим:** read-only анализ исходников и имеющихся тестов.
- **Baseline:** main, 2026-11-19.
- **Actions run:** 44385734444; worker mode: analysis-only.
- **Runtime checks:** npm ci, typecheck и test suite в этом SECURITY run НЕ запускались. В role-worker эти команды запускаются только для роли QA. Успешный workflow означает публикацию отчёта, а не Security QA PASS.

## Итог

Исходный AI-отчёт содержал неподтверждённые утверждения о LIVE execution. После проверки реальных call paths вывод исправлен:

- **Не подтверждается:** что текущий scheduled bot tick может открыть LIVE-ордер. В `src/bot.ts`, `runTick`, при `state.mode === "live"` выполнение останавливается ранним return до вызова `openLong`.
- **Подтверждается:** Mini App API имеет отдельный LIVE preview/confirmation flow. `src/api.ts`, `executeLiveTrade`, требует `body.confirm === true`, tenant-scoped preview record и неистёкший token; затем получает атомарный Durable Object claim и выполняет один `perps_execute_operation`. При неопределённом результате записывает `unknown`, возвращает HTTP 202 и не делает blind retry.
- **Подтверждается:** `src/trading/engine.ts`, `claimLive`, использует SQLite transaction для одноразового claim. Miniflare tests проверяют конкурентный claim, replay prevention, user isolation и expiry.
- **Defense-in-depth gap:** legacy `Walt.openLong()` / `Walt.closePosition()` в `src/walt.ts` сами вызывали `prepareAndExecute` и могли исполнить операцию после preview, если появится новый call site или регрессия guard. Текущий найденный call site openLong находится за ранним LIVE return; это не доказывает, что сейчас бот торгует автоматически. Fail-closed исправление опубликовано в Draft PR #282.
- **Account creation:** `src/commands.ts`, `conta`, вызывает `createAccount()` только после явной команды `/conta CONFIRMO`. В main сам adapter не требовал confirmation argument; дополнительная защита — в PR #282.

## Подтверждённые меры

### Auth и tenant isolation
- `src/companion.ts` требует Telegram initData в Authorization `tma`, проверяет подпись, срок auth_date и user ID.
- `src/tenants.ts`, `tenantEnv`, добавляет префикс `tenant:<userId>:` к KV get/put/delete/list; Companion history использует scoped namespace.
- `test/companion.test.ts` проверяет, что другой Telegram user не может прочитать или удалить чужой диалог.
- Глобальный OAuth client registration — отдельное намеренное исключение; pending OAuth state и user data tenant-scoped.

### Companion
- Handler Companion вызывает Gemini и tenant-scoped storage; в нём нет Walt/order tools.
- Режимы general/learning/research валидируются; существующий диалог нельзя переключить в другой mode.
- Вложения: максимум 4 файла, 5 MiB каждый, 8 MiB суммарно; MIME allowlist и Base64 validation; для MP4/WebM проверяются расширение и сигнатура контейнера.
- Research использует Google Search grounding, сохраняет только HTTPS source URLs и отказывает, если проверяемых источников нет.
- Существующие tests покрывают auth, expiry, tenant isolation, image/audio attachments, unsupported MIME, message length, max conversations, grounding и отсутствие fabricated sources.

### LIVE
- `previewLiveTrade` проверяет contract metadata, market allowlist, leverage, баланс, объём и Walt prepare result; confirmation token хранится в tenant-scoped KV с TTL.
- `executeLiveTrade` требует отдельный confirm, проверяет token/expiry, получает atomic claim, удаляет preview token как cleanup, делает один execute call и сохраняет completed/unknown.
- Ошибка или timeout после claim не приводит к blind retry; предусмотрен operation status для сверки.
- Scheduled legacy bot tick немедленно ставит LIVE на паузу.
- DEMO Durable Object engine отклоняет mode кроме demo; LIVE operations хранятся отдельно.

## Риски и пробелы

| Приоритет | Риск | Доказательство / влияние | Исправление |
|---|---|---|---|
| Medium | Неатомарные Gemini quotas | В `src/companion.ts` rate limit и research budgets реализованы KV read → increment → write. Параллельные запросы могут прочитать одно значение и превысить лимит; KV не является атомарным счётчиком. | Durable Object/SQLite atomic counter + concurrency tests. |
| Low | Ошибка research provider расходует дневную квоту | Research counters увеличиваются до вызова Gemini; 429/timeout/grounding error может списать попытку без результата. | Reserve/commit/release с учётом конкурентности. |
| Low | Нет magic-byte проверки image/audio | MIME и Base64 проверяются, сигнатура контейнера — только у video. Данные передаются модели, Worker их не исполняет. | Проверка сигнатур image/audio + spoofed MIME tests. |
| Medium | Legacy Walt methods имели опасную семантику | openLong/closePosition вызывали prepare+execute; текущий tick guard защищает найденный call site, но будущий caller мог бы обойти API confirmation gate. | Fail-closed methods + zero-MCP-call tests; PR #282. |
| Medium | Analysis-only ошибочно получал agent-done | Run 44385734444 завершился analysis-only, но main finalizer поставил agent-done, хотя требовалась ручная проверка. | agent-review вместо agent-done; PR #281. |

## Тесты и непроверенное

**Существующие тесты (в run 44385734444 не запускались):**
- `test/companion.test.ts`: auth, tenant isolation, attachments, research, limits.
- `test/trading-engine.miniflare.test.ts`: atomic LIVE claim, replay, cross-user isolation, expiry.
- `test/walt.test.ts`: contract parsing, включая contract ID 0.
- `test/api.test.ts`: общие auth/API/DEMO сценарии; полноценный успешный LIVE API execute path покрыт недостаточно.

**Не проверено:** npm ci/typecheck/tests в SECURITY run; реальный Walt sandbox E2E; физический iPhone/Telegram WebView; нагрузка KV quotas; внешние гарантии Walt confirmation token; production deployment/config. Реальные Walt writes не выполнялись.

## Следующие задачи
1. Проверить PR #282: fail-closed legacy methods, explicit account confirmation и API confirmation test.
2. Проверить PR #281: agent-review, role packet handoff и queue fallback.
3. Создать backend task на атомарные Companion quotas.
4. Добавить mock API tests на LIVE preview → confirm → single execute, duplicate, expired token и unknown reconciliation.
5. После CI и независимого review повторить Security QA.

**Статус принятия:** отчёт исправлен по исходникам, но это статический анализ, не независимый QA PASS и не разрешение на LIVE-операции.
