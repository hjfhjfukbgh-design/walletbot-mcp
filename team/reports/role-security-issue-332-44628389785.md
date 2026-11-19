# SECURITY — анализ задачи #332

- Режим: анализ, исходники не изменялись
- Задача: [KG-A-SECURITY] Verify Walt LIVE close operation contract

<!-- kg-child-task:v1;parent=239;key=a-live-close-contract-43;team=A;role=SECURITY;depends=none -->

## Цель
Перед реализацией LIVE close-flow установить точный подтверждённый контракт Walt MCP. Сейчас legacy `Walt.closePosition()` fail-closed, а UI не должен показывать LIVE close action без безопасного prepare → confirm → execute → reconciliation.

## Scope
- **S1:** Проверить `src/walt.ts`: какие реальные close/prepare/execute методы и tool names существуют; отличить legacy fail-closed методы от поддерживаемых методов.
- **S2:** Проверить `src/api.ts`: есть ли LIVE close preview/execute/operation route, atomic claim, expiry, replay protection и reconciliation для close, а не только для open.
- **S3:** Проверить существующие tests/docs/config: есть ли документированная schema/fixture для Walt close operation (обязательные поля, reduce-only, contractId, quantity, confirmation token).
- **S4:** Дать verdict по готовности: `VERIFIED` только если точный tool name + request/response schema подтверждены кодом или репозиторием; иначе `NOT VERIFIED` и список конкретных недостающих данных. Предложить минимальный безопасный следующий шаг, не выдумывая параметры.
- В отчёте указывать точные file/line evidence. Для каждого S1–S4 поставить отдельный статус.

## Запреты
Никаких реальных Walt MCP calls, listTools calls, orders, closes, transfers, account/position mutations, secrets или production. Не менять исходники. Не предполагать tool names и не копировать неизвестные payloads.

## Приёмка
Отчёт-only. Если хотя бы один ключевой пункт не подтверждён, общий verdict должен быть `INCOMPLETE`/ `NOT VERIFIED`, без PASS/ACCEPTED. Оставить agent-review до проверки Team Lead.

# Отчёт об анализе безопасности и готовности: Issue #332 (Verify Walt LIVE close operation contract)

**Роль:** SECURITY, команда Kripto Guru  
**Дата анализа:** 2026-11-19  
**Общий вердикт:** `NOT VERIFIED` (неполные данные для закрывающего контракта LIVE)

---

## Таблица проверки Scope (S1–S4 + обязательный S5)

| ID | Проверка | Точное доказательство (файл и строки) | Результат | Что не проверено / Пробелы |
|---|---|---|---|---|
| **[S1]** | Проверить методы/tool names в `src/walt.ts` (close/prepare/execute) | `src/walt.ts:L74-L92`, `src/walt.ts:L103-L107` | **NOT VERIFIED** | `closePosition` отключен (`throw new WaltError(...)`). Реальный закрывающий метод (`perps_prepare_close` / `perps_prepare_position_close` и т.д.) в `src/walt.ts` отсутствует и не задокументирован кодом. |
| **[S2]** | Проверить наличие LIVE close preview/execute/operation routes и механизмов в `src/api.ts` | `src/api.ts:L60-L65`, `src/api.ts:L357-L480`, `src/api.ts:L527-L610` | **NOT VERIFIED** | Реализованы только `live/preview` и `live/execute` для *открытия* (`perps_prepare_order_place`). Маршрутов и серверных хендлеров для *закрытия* (`live/close/preview`, `live/close/execute`) в `src/api.ts` нет. |
| **[S3]** | Проверить наличие схем/фикстур для Walt close operation | Отсутствует в `src/walt.ts`, `src/api.ts`, `README.md` | **NOT VERIFIED** | Отсутствуют схемы обязательных полей (`reduce-only`, `contractId`, `quantity`, `confirmation token`) для закрытия позиции через Walt MCP. |
| **[S4]** | Дать verdict по готовности (`VERIFIED` / `NOT VERIFIED`) | `README.md:L7-L8`, `README.md:L101-L103` | **NOT VERIFIED** | Точный tool name для закрытия и request/response schema не подтверждены кодом. Требуется реализовать prepare → confirm → execute → reconciliation для close. |
| **[S5]** | Указывать file/line evidence и отдельные статусы для S1–S4 | Выполнено во всех строках отчёта | **PASS** | — |

---

## Детальный анализ (Security & Threat Model)

### 1. Границы доверия и изоляция (Trust Boundaries & Tenant Isolation)
* **Клиент vs Сервер:** UI и Mini App не доверяют пользовательскому вводу. Все параметры (плечо, маржа, рынок, лимиты) пересчитываются и проверяются на сервере (`src/api.ts`).
* **Мультитенантность:** Каждый пользователь Telegram изолирован в собственном пространстве KV через префиксы (`src/tenants.ts`), что предотвращает пересечение данных учетных записей или токенов OAuth.

### 2. Управление деньгами и рисками (Money & Risk Limits)
* **DEMO / Paper Trading:** Полностью изолирован, использует виртуальный капитал (`src/state.ts`), строгие лимиты убытков и экспозиции (`src/risk.ts`).
* **LIVE Режим:** Заблокирован по умолчанию. Использование старых методов (`closePosition` / `openLong`) в `src/walt.ts:L79-L92` намеренно выбросит `WaltError`, предотвращая автоматическое исполнение без двухэтапного подтверждения.
* **Идемпотентность и Replay Protection:** Для LIVE-ордеров на открытие задействованы Durable Object (`TradingEngine`) с атомарным клеймом (`/live/claim`), TTL-префиксы и проверка временных меток (`src/api.ts:L559-L571`, `src/trading/engine.ts`).

### 3. Угрозы при закрытии позиции (Close-Flow Gaps)
* В текущей архитектуре **открытие** защищено полным циклом (`perps_prepare_order_place` → `live:preview` с TTL 120с → `/live/claim` → `perps_execute_operation` → `/live/finish` с последующей `reconciliation`).
* **Закрытие (`closePosition`)** в `src/walt.ts:L90-L92` возвращает `never` с ошибкой безопасности. Отсутствуют соответствующие серверные маршруты в `src/api.ts` и подготовка через закрывающий tool name MCP (например, `perps_prepare_close` или аналог).

---

## Резюме и следующий безопасный шаг

* **Общий вердикт:** `NOT VERIFIED` (Интерфейс и бэкенд остаются fail-closed для LIVE close).
* **Минимальный безопасный следующий шаг:** 
  1. Запросить у спецификации Walt MCP точное имя инструмента подготовки закрытия (`perps_prepare_close_*`) и его обязательную схему.
  2. Реализовать в `src/walt.ts` метод `prepareClosePosition` и безопасный two-step execute по аналогии с `previewLiveTrade`.
  3. Добавить в `src/api.ts` маршруты `POST live/close/preview` и `POST live/close/execute` с сохранением логики атомарного клейма, TTL, replay protection и read-only reconciliation.
  4. Запретить включение LIVE режима в UI (`src/api.ts:L806-L807`, `README.md:L7`) до полного покрытия Close-flow тестами с моками.

### Автоматическая проверка ссылок
- NOT VERIFIED: Строка **[S5]** помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.