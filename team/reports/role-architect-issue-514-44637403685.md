# Исправленный ADR — конкурентность AI Companion (#514)

**Вердикт: PARTIAL / NOT VERIFIED.** Ни текущая реализация, ни report-only PR #513 не обеспечивают FIFO для параллельных сообщений одного диалога. Ниже — архитектурное решение и границы доказательств; исходники не изменялись.

## 1. Подтверждённый дефект текущего кода

- `src/companion.ts:18-28`: обработчик валидирует Telegram initData и получает tenant-scoped KV через `tenantEnv`.
- `src/companion.ts:115-136`: существующий диалог читается из KV, затем на его снимке формируется новая история.
- `src/companion.ts:157-181`: до записи истории выполняются два асинхронных внешних перехода — запрос к quota Durable Object и Gemini `fetch`.
- `src/companion.ts:228-240`: после ответа Gemini весь массив сообщений записывается одним KV `put`.
- `src/tenants.ts:13-16`: tenant isolation обеспечивается префиксом `tenant:${userId}:`; он не сериализует два запроса к одному conversation key.

**Race:** запросы A и B могут прочитать один и тот же snapshot до Gemini fetch. Пока A ждёт Gemini, B также читает snapshot и вызывает Gemini. Если B завершится первым, а A последним, последний KV put перезапишет историю B своей копией. Возможны потеря user message и ответа; порядок ответов не гарантирован. Global quota DO сериализует только quota accounting, не весь conversation lifecycle.

## 2. Cloudflare semantics — что подтверждено

1. Durable Objects выполняют JavaScript в single-threaded isolate, но это **не** сериализация полного async handler: во время `await fetch()` input gate открывается и другие события могут interleave. См. официальные правила и race-condition example: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
2. Storage operations имеют input/output gate protections; SQLite `transactionSync` callback обязан быть синхронным. Нельзя держать SQLite transaction вокруг Gemini fetch. См. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
3. `blockConcurrencyWhile()` способен блокировать другие события на время async callback, но callback имеет 30-second timeout; при превышении объект reset. При Gemini timeout 25s и дополнительных quota/storage этапах это слишком хрупкий основной механизм. См. https://developers.cloudflare.com/durable-objects/api/state/
4. In-memory state теряется при eviction/reset. Durable state должна храниться в DO storage. При deferred code update старый isolate может продолжить работу до max_delay (по умолчанию 300s); это best effort, не гарантия завершения каждого in-flight запроса. См. https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

## 3. Варианты

| Вариант | Плюсы | Риски / решение |
|---|---|---|
| `blockConcurrencyWhile` вокруг всего chat lifecycle | Минимум изменений, сохраняет синхронный HTTP ответ | 30s timeout/reset, долгий Gemini блокирует весь conversation object; не даёт durable request id и recovery. Не выбирать как основной механизм. |
| In-memory mutex / Promise chain | Просто, низкая задержка | Теряется при eviction/reset; нет durable FIFO, crash recovery или fencing. Отклонить. |
| Durable FIFO в per-conversation DO | Персистентный порядок, recovery, tenant isolation, идемпотентность | Нужны queue schema, polling/status contract и migration plan. **Рекомендуется.** |
| Один DO на пользователя | Сериализация всех его диалогов | Лишняя блокировка независимых conversations. Не выбирать, если достаточно per-conversation DO. |

## 4. Рекомендуемая архитектура

**Один SQLite-backed Durable Object на пару `(telegramUserId, conversationId)`.** Идентификатор DO строится сервером как стабильный tenant-bound name; клиент не задаёт tenant ID. Существующий global quota DO остаётся отдельным сервисом.

Persisted таблица очереди содержит как минимум:
- `request_id` UNIQUE, `sequence`, conversation key, payload reference, mode;
- `status`: QUEUED / PROCESSING / COMPLETED / FAILED_RETRYABLE / FAILED_FINAL;
- `lease_generation`, `lease_expires_at`, timestamps, bounded retry count;
- serialized result/error для повторного чтения результата.

Алгоритм:
1. Принимать запрос и атомарно вставлять его в FIFO. Повтор того же `request_id` с тем же payload возвращает существующую запись; тот же ID с другим payload — 409.
2. Claim следующего элемента делать короткой `transactionSync`: только один активный lease на conversation, sequence строго возрастает, generation увеличивается.
3. Выполнять Gemini **вне** SQL transaction. Не держать transaction или storage cursor через `await`.
4. После ответа коммитить результат только если request всё ещё PROCESSING и generation совпадает. Это fencing против просроченного worker.
5. Следующий элемент запускать только после фиксации COMPLETED/FAILED. Alarm ставится на lease expiry для восстановления после reset/timeout; alarm delivery может задерживаться, поэтому не обещать точный realtime SLA.
6. Повторный POST с тем же request_id читает persisted status/result. UI может ждать обычный ответ, а после сетевого timeout — опрашивать status endpoint; не создавать новый request_id при retry.
7. Ошибки Gemini/429/timeout переводить в bounded retryable/final state; не сохранять частичный assistant response. Повтор Gemini может дать иной текст, но один request_id имеет только один окончательно зафиксированный результат.

**HTTP contract:** сохранить `POST /api/companion/chat` с requestId, добавить read-only `GET /api/companion/requests/:requestId` для восстановления после timeout. Если UI не может безопасно удерживать запрос до завершения, POST возвращает 202 + requestId и UI polling; никакого fake success.

## 5. KV → DO migration

Не переносить все диалоги одномоментно и не делать dual-write без протокола. Для каждого conversation:
- новый DO начинает с `migration_state=NOT_STARTED`;
- читает legacy KV только по tenant-scoped ключу;
- в одной локальной SQLite transaction импортирует snapshot и ставит `migration_state=COMPLETE`; уникальный conversation ID делает повтор импорта идемпотентным;
- после COMPLETE все чтения/записи идут через DO; старый KV key сохраняется на период rollback, но больше не является write target;
- нужен staged rollout: сначала compatibility release, направляющий все новые writes в DO, затем migration enablement после контроля старых in-flight requests. Deferred update max_delay нельзя трактовать как строгую гарантию drain.

KV и SQLite — разные storage systems; атомарной cross-store transaction нет. Поэтому «прочитать KV + записать SQLite + удалить KV» одной атомарной операцией невозможно. Не удалять legacy data в первой версии.

## 6. Tenant isolation и failure matrix

- DO name включает проверенный server-side Telegram userId и conversationId; никакого client-supplied userId.
- Одинаковый conversationId у двух пользователей создаёт разные DO.
- Concurrent A/B одного диалога: FIFO sequence, обе пары user/assistant сохраняются.
- Duplicate requestId: тот же результат, без второго assistant append.
- Crash до Gemini: lease expiry → bounded retry.
- Crash после ответа Gemini, до commit: повторный Gemini допустим (read-only generation); fencing допускает только один commit.
- Старый worker после lease expiry: generation mismatch → его результат не коммитится.
- Duplicate alarm / retry: атомарный claim исключает два действующих владельца.
- Cross-tenant request/status lookup: 404/403 без раскрытия existence чужого диалога.

## 7. Cost / plan limits

**NOT VERIFIED:** текущий Cloudflare account plan, фактическое включённое usage и account spending limit из репозитория не видны. Не обещать «нулевую стоимость». Cloudflare указывает, что Durable Objects учитывают requests/duration и SQLite rows read/written; см. https://developers.cloudflare.com/durable-objects/platform/spend-management/ и storage billing: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/. Перед rollout проверить план/usage в dashboard.

## 8. Implementation-sized follow-ups

1. **Backend:** per-conversation DO + persisted FIFO/lease/fencing + request status API; только mock Gemini.
2. **QA:** Miniflare concurrency, duplicate request, timeout/crash/fencing, tenant collision and migration tests.
3. **Frontend:** retain requestId on retry and poll status after ambiguous network timeout.
4. **Release:** staged compatibility rollout; KV legacy data retained; no production migration until rollback procedure tested.

## Evidence boundaries

- **VERIFIED:** текущий read → await Gemini → whole-conversation KV put path; tenant-prefixed KV; official Cloudflare input-gate, storage transaction, eviction/reset and alarm semantics cited above.
- **NOT VERIFIED:** production concurrency frequency, account-specific plan/charges, alarm latency under this deployment, and any production data migration behavior.
- **Not claimed:** this ADR is not an implementation, not proof that the proposed FIFO exists, and not authorization for LIVE or production changes.
