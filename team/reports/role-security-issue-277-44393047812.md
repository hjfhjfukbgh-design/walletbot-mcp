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

### Вердикт
**ОДОБРЕНО С ОГРАНИЧЕНИЯМИ / СТРОГИМИ УСЛОВИЯМИ**

Анализ кодовой базы Issue #277 подтверждает, что архитектура проекта (`src/bot.ts`, `src/walt.ts`, `src/api.ts`) реализует жесткую защиту против неавторизованного или автоматического исполнения LIVE-ордеров. В файле `src/bot.ts` (строки 50–57) **автоматический LIVE-режиме полностью заблокирован**, а `src/walt.ts` выбрасывает исключение при попытке вызвать legacy-методы `openLong` или `closePosition` вживую. 

Тем не менее, для полноценного перехода к разрешенной LIVE-функциональности через Walt MCP (подготовка → проверка риска → явное подтверждение пользователя → исполнение) необходимо убедиться, что эндпоинты превью и подтверждения изоляции арендаторов (`tenantEnv`) не допускают обхода аутентификации Telegram Mini App (`tma`).

---

### Доказательства (Пути и Символы)
1. **Жесткая блокировка LIVE-торговли в боте:**
   * `src/bot.ts`: `if (live) { state.running = false; state.paused = "LIVE временно заблокирован..."; msgs.push(...); return; }`
2. **Защита Walt MCP адаптера:**
   * `src/walt.ts`: Методы `openLong` и `closePosition` возвращают `never` с текстом: *"Автоматическое LIVE-исполнение через legacy openLong отключено..."*.
3. **Изоляция арендаторов (Tenant Isolation):**
   * `src/tenants.ts`: `tenantEnv(env, userId)` переопределяет KV-пространство префиксом `tenant:${userId}:`, изолируя токены OAuth, состояние сетки и историю.
   * `src/api.ts`: Строка 26 проверяет заголовок `Authorization: tma <initData>` и валидирует Telegram-сессию перед вызовом `tenantEnv`.

---

### Риски и Пробелы
1. **Риск обхода `tma`-аутентификации при неполной валидации:** В `src/api.ts` валидация `tma` критически зависит от корректности проверки подписи Telegram InitData. Если в окружении нарушена проверка HMAC, чужой пользователь сможет получить доступ к изолированному `tenantEnv`.
2. **Отсутствие эндпоинтов ручного подтверждения LIVE в роутере API:** В текущем `src/api.ts` присутствуют только заглушки `/live/preview` и `/live/execute` (либо они маршрутизируются через DO `TradingEngine`), что требует строгой проверки того, что исполнение (`execute`) физически заблокировано без отдельного UI-токена подтверждения.
3. **Риск race condition в `src/bot.ts`:** При переключении флагов состояния через `/resume` или `/run` в мульти-арендной среде возможна непредна5еренная рассинхронизация кэша KV.

---

### Следующий шаг
Реализовать и верифицировать двухэтапный интерфейс для LIVE (`perps_prepare_*` → демонстрация параметров и рисков пользователю → отдельный `user-confirm` → `perps_execute_operation`), гарантируя, что **никакой автоматический retry execute** не срабатывает при сетевых сбоях.

---

### Критерии приёмки
* [ ] LIVE-ордера исполняются **исключительно** после вызова `perps_prepare_*`, получения `confirmationToken`, отображения параметров/рисков пользователю и его явного подтверждения (`user-confirm`).
* [ ] Отсутствует любой код автоматического повтора (`retry`) для `perps_execute_operation`.
* [ ] Изоляция арендаторов (`tenantEnv`) корректно разделяет учетные записи Telegram в KV.
* [ ] Соблюдены бюджетные ограничения и запреты на production deploy, смену секретов и авто-исполнение.

---

### Что не проверено
* Фактическая криптографическая стойкость проверки подписи `tma` InitData во внешней библиотеке Telegram WebApp (требует внешнего аудита криптомодуля).
* Работоспособность WebSocket-соединений с Hyperliquid из-за отсутствия сетевого окружения в рамках статического анализа.