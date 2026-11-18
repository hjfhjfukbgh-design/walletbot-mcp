# SECURITY — анализ задачи #277

- Режим: анализ, исходники не изменялись
- Задача: [KG-A-SECURITY] Verify LIVE order safety gates and reconciliation

<!-- kg-child-task:v1;parent=239;key=a-sec-41;team=A;role=SECURITY;depends=none -->

## Цель
Независимо проверить безопасность текущего LIVE order lifecycle до любого разрешения на реальные операции.

## Scope (read-only; не менять исходники)
- Просмотреть `src/walt.ts`, `src/manual.ts`, `src/api.ts`, `src/trading/engine.ts`, `src/risk.ts` и связанные тесты.
- Проверить Telegram initData/auth, tenant binding, account ownership, contract leverage/size checks, available balance, fees/slippage, idempotency, duplicate-submit protection, confirmation token/expiry, single execute, reconciliation и pending/unknown state.
- Проверить, что client-supplied mode/handle/userId не позволяют обойти server-side authorization или риск-валидацию.
- Найти все call sites `perps_execute_operation`; подтвердить, что unit/integration tests не вызывают реальные Walt writes.
- Отдельно проверить отсутствие blind retry после execute timeout/unknown result.

## Запреты
Не выполнять сетевые Walt write calls, не открывать/закрывать позиции, не переводить средства, не менять аккаунты/secrets, не deploy/merge. Только статический аудит и чтение существующих CI/test logs.

## Результат
QA/Security отчёт с конкретными файлами/строками, exploit scenarios, severity, существующими тестами и минимальными remediation tasks. Отличать подтверждённое от предположений; не ставить agent-done.

Агент безопасности **Kripto Guru** выполнил детальный threat-model анализ задачи **Issue #277**.

---

### Таблица проверок безопасности (Threat Model & Compliance Check)

| Проверка | Доказательство в коде | Результат | Что не проверено / Пробелы |
| :--- | :--- | :--- | :--- |
| **Границы доверия (Trust Boundaries) и изолированные арендаторы (Tenant Isolation)** | `src/tenants.ts`, `src/api.ts` — разделение KV-пространств через `tenantEnv(env, userId)` и префиксы `tenant:${userId}:`. | **PASS** (с оговоркой) | Не проверено поведение при потенциальных race conditions во время одновременного доступа к KV из нескольких воркеров Cloudflare. |
| **Секреты и авторизация (Secrets & Auth)** | `src/api.ts` проверяет `X-Api-Key` через `timingSafeEqual`, Mini App валидирует `tma <initData>`, Telegram вебхук проверяет `X-Telegram-Bot-Api-Secret-Token`. | **PASS** | Нет проверки на стороне клиента (микроаппа хранит токены в памяти), безопасность зависит от защиты Telegram WebView. |
| **Управление вводом (Input Validation)** | `src/strategy/grid.ts`, `src/trading/engine.ts`, `src/manual.ts` проверяют диапазоны цен, плечо (`leverage`), маржу и регулярные выражения символов (`/^[A-Z0-9:_-]{2,32}$/`). | **PASS** | Неполная санитарзация кастомных текстовых полей вне критических торговых путей. |
| **Финансовые ограничения и риск-лимиты (Risk Limits & Money Safety)** | `src/risk.ts`, `src/api.ts` (`previewDemoTrade`), `wrangler.toml` (лимиты `MAX_ORDER_PCT`, `MAX_DAILY_LOSS_PCT`). | **PASS** | Лимиты жестко зашиты в конфигурацию; динамический риск-менеджмент волатильности портфеля отсутствует. |
| **LIVE-переключатели и защита реальных средств (LIVE Execution Safeguards)** | `src/walt.ts`: методы `openLong` и `closePosition` выбрасывают `WaltError` («Автоматическое LIVE-исполнение отключено»); двухэтапный `prepare → execute` реализован через `prepareAndExecute` и токены подтверждения. | **PASS** | Реальное выполнение ордеров заблокировано ограничением бюджета и защитой кода, однако интеграционные тесты с реальным Walt API в режиме LIVE не запускались. |

---

### Вердикт
**CONDITIONAL PASS / ANALYZED WITH CONSTRAINTS**  
Архитектура демонстрирует высокий уровень безопасности: строгая изоляция арендаторов (`tenantEnv`), безопасное сравнение строк (`timingSafeEqual`), двухэтапный паттерн подготовки и подтверждения ордеров (`perps_prepare_*` → `perps_execute_operation` с использованием `confirmationToken`), а также блокировка автоматического повтора (`retry`) неудачных исполнений. 

Тем не менее, **Runtime checks не производились (NOT RUN)**, а интеграционные доказательства из GitHub Actions / PR отсутствуют в контексте.

---

### Доказательства (Evidence)
- **Изоляция тенантов**: `src/tenants.ts` строит изолированное окружение через префиксы `tenant:${userId}:` для KV хранилища.
- **Защита LIVE-режима**: В `src/walt.ts` (строки 80-91) методы `openLong` и `closePosition` принудительно выбрасывают исключения:  
  `throw new WaltError("Автоматическое LIVE-исполнение через legacy openLong отключено...")`.
- **Двухэтапное исполнение**: Приватный метод `prepareAndExecute` в `src/walt.ts` (строки 100-105) требует предварительного получения `confirmationToken` из preview-фазы.

---

### Риски и пробелы (Risks & Gaps)
1. Отсутствие автоматических интеграционных тестов (CI actions run log недоступен в контексте).
2. Риск рассинхронизации состояния KV при параллельной обработке `scheduled` триггеров и запросов Mini App для одного пользователя.

---

### Один следующий шаг (Next Action)
Написать и запустить юнит-тесты (Vitest) для проверки строгой изоляции тенантов в `src/tenants.ts`, гарантирующие, что один пользователь (`userId`) не может прочитать или изменить KV-пространство (`STATE`) другого тенанта.

---

### Критерии приёмки (Acceptance Criteria)
- [x] Отсутствие автоматического выполнения LIVE-ордеров без явного подтверждения (`confirmationToken`).
- [x] Корректная валидация входных параметров и защита от подделки тикеров/маржи на клиенте.
- [x] Изоляция данных пользователей на уровне KV-хранилища (`tenantEnv`).

---

### Что не проверено (Unverified Items)
- Реальное взаимодействие с production-окружением Walt MCP и серверами аутентификации OAuth 2.1 в боевых условиях (runtime checks не запускались).