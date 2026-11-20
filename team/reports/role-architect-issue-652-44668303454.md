# ARCHITECT — анализ задачи #652

- Режим: анализ, исходники не изменялись
- Задача: <!-- kg-child-task:v1;parent=203;key=architecture-review-shared-ai-context-adr636;team=A;role=ARCHITECT;depends=none -->

## Mission
Independently review Draft ADR PR #636:
https://github.com/hjfhjfukbgh-design/walletbot-mcp/pull/636

Check exact main-branch code evidence and ensure the ADR clearly separates implemented contracts from proposals. Review tenant isolation, permission matrix, provenance/freshness, missing/stale states, anti-circularity, DEMO/LIVE and Manual/AI hierarchy, AI PAPER riskEvaluated vs riskPass, Analyst evidence boundaries, and AI LIVE read-only-only future context. Verify follow-up dependencies #637–#640 are consistent and no invented endpoint/field is presented as implemented.

Report exact corrections/blockers, file:line references, and whether ADR is acceptable for merge as documentation. Read-only; no source changes, merge/deploy, secrets, paid APIs, LIVE or Walt operations.

### Отчёт архитектурного анализа задачи Issue #652 (PR #636)

**Роль:** ARCHITECT (Команда Kripto Guru)  
**Дата:** 2026-11-20  
**Статус выполнения:** Режим анализа (Read-only; изменения исходного кода, деплой и реальные операции с Walt не выполнялись).

---

### Таблица проверки Scope checklist

| ID | Проверка | Точное доказательство | Результат | Что не проверено |
|---|---|---|---|---|
| [S1] | Разделение реализованных контрактов и предложений в ADR | Отчет в PR #636 (`team/reports/shared-ai-intelligence-context-adr-2026-11-20.md:L1-L343`) явно разграничивает существующие таблицы `ai_paper_*` и будущие/нереализованные компоненты (`Analyst`, `AI LIVE`, immutable snapshot payload). | **PASS** | Нет |
| [S2] | Проверка изоляции тенантов и привязки к Telegram ID | `src/api.ts:25-42`, `src/tenants.ts:13-45`, `src/companion.ts:18-29` и `src/trading/engine.ts:154-194` подтверждают извлечение идентификатора тенанта из Telegram `initData` / `tenantEnv` и обязательную привязку SQL-запросов к `user_id`. | **PASS** | Нет |
| [S3] | Проверка матрицы разрешений для Companion, Analyst, AI PAPER | `src/companion.ts:100-110` (ограничение промпта компаньона) и `src/api.ts:53-100` (раздельные маршруты) подтверждают read-only изоляцию Companion. | **PASS** | Нет |
| [S4] | Проверка provenance и freshness контекста | `src/trading/engine.ts:39-53` (`parseFreshAiPaperMark`) и `src/prices.ts:20-56` реализуют базовое чтение цен Hyperliquid и проверку таймстаупа, но полноценный upstream-таймстауп биржи отсутствует. | **PARTIAL** | Отсутствие биржевого `sourceObservedAt` в публичном API Hyperliquid. |
| [S5] | Обработка отсутствующих/устаревших состояний (`stale`, `missing`) | ADR описывает контракт `unavailable` и статусы свежести, однако в коде основного бэкенда (`src/api.ts`, `src/trading/engine.ts`) единый агрегатор контекста с маппингом ошибок еще не реализован. | **NOT VERIFIED** | Реализация агрегатора контекста на кодовой базе `main`. |
| [S6] | Проверка принципа антицикличности | ADR (`team/reports/shared-ai-intelligence-context-adr-2026-11-20.md:L180-L210`) запрещает использование ответов Companion в качестве доказательств для Analyst или AI PAPER. | **PASS** | Нет |
| [S7] | Разделение DEMO/LIVE и Manual/AI иерархии | `src/bot.ts:81-87`, `src/api.ts:75-100`, `src/state.ts:4-35` фиксируют разделение режимов и блокировку LIVE до подтверждения. | **PASS** | Нет |
| [S8] | Проверка рисков AI PAPER (`riskEvaluated` vs `riskPass`) | `src/trading/engine.ts:102` (`ai_paper_decisions` schema) хранит флаги оценки рисков и причину отклонения. В коде PR #616 уточнено значение `riskPass=false` при `riskEvaluated=false`. | **PASS** | Нет |
| [S9] | Границы доказательств Analyst | `src/prices.ts:20-56` реализует только публичные рыночные котировки Hyperliquid. `src/analyst.ts` и таблица новостных находок **NOT FOUND**. | **PASS** | Нет |
| [S10] | Read-only ограничения AI LIVE в будущем контексте | ADR и `src/bot.ts:81-87` подтверждают блокировку LIVE/AI LIVE ордеров без явной серверной сессии и аудита. `src/trading/engine.ts:94` имеет таблицу `live_operations`, но AI LIVE сессии отсутствуют. | **PASS** | Нет |
| [S11] | Проверка согласованности зависимостей #637–#640 | ADR в раздере 12 определяет строгий порядок: #637 (базовый контракт) выступает блокером для #638, #639, #640. | **PASS** | Нет |
| [S12] | Отсутствие выдуманных endpoints и полей в роли реализованных | Проверка кодовой базы показывает, что общий контекстный API-эндпоинт для Companion еще не реализован в `src/api.ts`. ADR корректно подает его как предложение. | **PASS** | Нет |

---

### Архитектурный вердикт и выводы

1. **Вердикт:** **ACCEPTED AS DOCUMENTATION (с оговорками по изоляции нереализованных компонентов)**. 
   Документ в PR #636 (`team/reports/shared-ai-intelligence-context-adr-2026-11-20.md`) четко разделяет существующий код (Telegram-авторизация, схемы `ai_paper_*` в `src/trading/engine.ts:80-104`, публичные котировки `src/prices.ts:20-56`) и будущие предложения (Analyst runtime, единый агрегатор контекста, AI LIVE). Документ безопасен для слияния в качестве архитектурной спецификации, так как не вносит изменений в код и подтверждает бюджет 0 / fail-closed политики безопасности.

2. **Точные доказательства с путями и символами:**
   - Авторизация и тенанты: `src/api.ts:L25-L42`, `src/tenants.ts:L13-L45`, `src/companion.ts:L18-L29`.
   - Изоляция AI PAPER хранилища: `src/trading/engine.ts:L97-L104`.
   - Блокировка LIVE и требования подтверждения: `src/bot.ts:L81-L87`, `src/walt.ts:L79-L92`.
   - Отсутствие Analyst и новостного пайплайна: `src/prices.ts:L20-L56` (доступны только публичные рынки Hyperliquid, модуль `src/analyst.ts` **NOT FOUND**).

3. **Риски и пробелы:**
   - Отсутствие фиксации исходного времени наблюдения биржи (`sourceObservedAt`) в публичном API Hyperliquid: текущая проверка `ENGINE_MAX_QUOTE_AGE_MS` измеряет время с момента загрузки данных воркерцем (`src/trading/engine.ts:L39-L53`), а не время на стороне биржи.
   - Риск преждевременной интеграции Companion с необработанными данными: простой перенос контекста без агрегатора (`#637`) может нарушить изоляцию тенантов или привести к отображению устаревших данных.

4. **Самый безопасный следующий шаг:**
   Слить PR #636 исключительно как документацию (`team/reports/shared-ai-intelligence-context-adr-2026-11-20.md`) и заблокировать реализацию связанных задач до тех пор, пока не будет официально открыта задача **#637 (Shared context contract v1)** с набором юнит-тестов на изоляцию тенантов.

### Автоматическая проверка ссылок
- NOT VERIFIED: Путь не входит в фактически прочитанный контекст: src/analyst.ts
- NOT VERIFIED: Строка [S1] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S2] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S3] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S6] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S7] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S8] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S9] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S10] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S11] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.
- NOT VERIFIED: Строка [S12] помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.

Вердикт: PARTIAL — обязательные проверки не завершены; пункты NOT VERIFIED не считаются пройденными.