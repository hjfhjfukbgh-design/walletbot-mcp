# Kripto Guru — AI Companion architecture baseline

**Дата:** 2026-11-18  
**Основа:** read-only review of `main`, включая UI, API, package manifest и source tree.  
**Runtime/model status:** не проверялись; в текущем репозитории не найден подключённый пользовательский LLM backend.

## Executive verdict

AI Companion пока отсутствует как продуктовая функция. В Mini App нет chat screen или conversation history; в API нет chat/session routes; в source tree нет Companion service, model adapter, conversation store или preference model. `.github/workflows/ai-team-dispatcher.yml` относится к инженерным агентам GitHub Actions и не является пользовательским AI Companion.

Нельзя честно обещать универсальный чат до выбора и проверки runtime model path. При бюджете 0 сначала нужно определить доступный бесплатный inference path и его реальные лимиты; не подключать платный API автоматически и не использовать ключи GitHub Actions как ключи пользовательского продукта.

## Целевой продуктовый контракт

Один универсальный собеседник для:
- свободного повседневного общения;
- обучения и объяснений;
- технологий, работы, планирования, идей;
- помощи по самому приложению;
- рыночного анализа по явному запросу;
- контекстного перехода в отдельный AI Trading workspace только когда пользователь этого хочет.

Обычный разговор не должен превращаться в торговую рекомендацию. Никаких ордеров, переводов, изменения аккаунта или исполнения стратегий из Companion.

## Режимы и маршрутизация

Использовать три явных intent class:

1. **GENERAL** — обычный разговор. Нет доступа к рыночным write-инструментам или счётным операциям.
2. **MARKET_ANALYSIS** — чтение публичных котировок/графиков и объяснение данных. Все данные снабжать source + observedAt; при stale data явно сообщать об ограничении.
3. **AI_TRADING** — отдельный экран и отдельный сервис. Companion может предложить перейти туда, но не запускать стратегию или изменять paper account самостоятельно.

Маршрутизация должна быть консервативной: если намерение неоднозначно, продолжать GENERAL или задать короткий уточняющий вопрос. Текст пользователя и результаты инструментов — недоверенные данные, а не инструкции для изменения прав доступа.

## Conversation data model

- `Conversation`: `conversationId`, `userId`, `title`, `createdAt`, `updatedAt`, `archivedAt?`, `pinnedAt?`.
- `Message`: `messageId`, `conversationId`, `role`, `content`, `createdAt`, `status`, `modelInfo?`, `usage?`, `errorCode?`.
- `ConversationContext`: короткий ограниченный контекст текущей сессии; TTL/лимит размера, не превращать автоматически в долговременную память.
- `UserPreferences`: явные настройки языка, стиля объяснений, формата ответа и опциональных рынков/горизонта. Каждое поле редактируемо и удаляемо пользователем.
- `MemoryItem`: только если позднее появится отдельная функция памяти с явным UX просмотра, изменения и удаления. Не выводить скрытые выводы модели в профиль пользователя.

## UX contract

### Main Companion screen
- Заголовок «AI Companion» и понятное описание универсальной функции.
- Чистая область сообщений, streaming-ready composer, stop generation, retry, copy.
- Предложения начала диалога не должны быть только про трейдинг.
- Контекст рынка отображать только при его явном подключении; визуально маркировать источник и время данных.
- При отсутствии model backend показывать честное состояние «AI пока не подключён», не имитировать ответы.

### History
- Список разговоров с поиском.
- Rename, pin, archive, delete с подтверждением.
- Пустое, offline, loading, error и retry состояния.
- Пагинация/ленивая загрузка; не выгружать всю историю в один запрос.

### Settings / personalization
- Пользователь видит точный список сохранённых предпочтений.
- Для каждого поля доступны edit/reset.
- Отдельное действие очистки истории и отдельное действие очистки настроек.
- Не хранить API keys, пароли, seed phrases, банковские или иные секреты.
- Никакого скрытого профилирования и автоматического сохранения чувствительных тем.

## API proposal

- `GET /api/companion/conversations?cursor=`
- `POST /api/companion/conversations`
- `PATCH /api/companion/conversations/:id` — rename/pin/archive.
- `DELETE /api/companion/conversations/:id`
- `GET /api/companion/conversations/:id/messages?cursor=`
- `POST /api/companion/conversations/:id/messages` — streaming-ready response.
- `GET/PATCH /api/companion/preferences`
- `DELETE /api/companion/preferences`

Все запросы должны выводить userId только из проверенной Telegram initData и проверять ownership conversationId на сервере. Нельзя доверять userId из body/query.

## Model gateway / бюджет

Ввести внутренний интерфейс `ChatModel.generate(...)` и adapter boundary, но не подключать провайдера, пока не проверены:
- доступность без платёжного метода;
- реальные бесплатные лимиты и rate limits;
- допустимость коммерческого использования;
- latency и streaming support;
- политика хранения и обработки данных;
- fallback и поведение при исчерпании квоты.

В текущем `package.json` нет AI SDK; в runtime env/bindings, просмотренных в `wrangler.toml`, не найдено подтверждённого AI provider binding. Gemini secrets, используемые инженерными Actions, не являются автоматически доступным или допустимым backend для пользовательских диалогов. До проверки provider path полноценный универсальный чат — BLOCKED; UI можно подготовить только с честным disabled/empty state.

## Tool permissions

- GENERAL: только chat model; никакого account access.
- MARKET_ANALYSIS: read-only market data, никакого изменения счёта.
- AI_TRADING: отдельный сервис с отдельным paper account и отдельными разрешениями.
- Companion не получает Walt write/execute methods ни в одном intent.
- Любой будущий финансовый action требует отдельного интерфейса, отдельной авторизации и отдельного подтверждения; не часть Companion.

## Implementation sequence

1. **COMP-01 Model provider feasibility:** исследовать бесплатные/доступные inference варианты; зафиксировать фактические квоты, legal/terms, privacy и latency. Никаких ключей в коде.
2. **COMP-02 Conversation storage/API:** tenant-scoped conversation/message CRUD, ownership tests, pagination, retention policy.
3. **COMP-03 Model gateway:** provider adapter, timeouts, rate limits, streaming/fallback; fail closed при отсутствии provider.
4. **COMP-04 Companion UI:** chat, history, rename/archive/delete, composer, retry/error/offline/empty states; no fake chat.
5. **COMP-05 Preferences/privacy:** explicit editable preferences, export/delete semantics, tests against cross-tenant access.
6. **COMP-06 Intent routing & tool scopes:** GENERAL/MARKET_ANALYSIS/AI_TRADING separation, prompt injection tests, read-only tool boundary.
7. **COMP-07 Evaluation & observability:** latency, failure, quota, safety, user feedback; no hidden retention.

## Acceptance gates

- Universal non-trading conversations work through a verified model adapter.
- If model unavailable/quota exhausted, user receives honest recoverable error; no fabricated response.
- Conversation IDs cannot be read or changed across tenants.
- User can search, rename, archive and delete conversations.
- Preferences are explicit, inspectable, editable and deletable.
- GENERAL cannot call market write tools or trading/account tools.
- MARKET_ANALYSIS is read-only and labels source/time.
- AI_TRADING remains a separate paper-only product.
- No paid provider is enabled without explicit budget approval.
