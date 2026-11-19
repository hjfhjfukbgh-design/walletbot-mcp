# Текущий статус штаба

Дата аудита: 2026-11-17.

## Репозиторий

- Репозиторий: `hjfhjfukbgh-design/walletbot-mcp`
- Видимость: public.
- Основная ветка: `main`.
- Дополнительный бюджет на ИИ/API: 0.
- Рабочая ветка штаба: `team/ai-operations-bootstrap-20261117`.

## Найдено

- В репозитории уже есть `.github/workflows/` с deploy, измерительным и UI-preview workflow.
- Есть `docs/` с API-контрактом и заметками по бюджету Trading Engine.
- В открытых PR обнаружен #32 — DEMO Engine runtime diagnostics. На момент аудита PR открыт, CI для commit `31f8f14e1c6afffb62b209542a789efb724701ac` завершился успешно. Это не означает, что PR уже прошёл полный независимый review или должен быть слит.
- PR #19 — старый черновик координации двух ChatGPT-сеансов. Он содержит полезный протокол, но его описание задачи устарело; PR не следует автоматически сливать.
- Есть и другие открытые черновые PR по Mini App. Перед выбором следующей инженерной задачи нужно сверить их базовые ветки и зависимости.
- README на `main` содержит историческое описание прежней архитектуры бота. Его нельзя считать полной документацией текущего состояния Mini App без сверки с кодом и актуальными PR.

## Текущая цель

Сначала создать безопасную и прозрачную систему управления задачами. Не запускать платных ИИ-вызовов и не создавать иллюзию круглосуточной автономной команды.

## Не подтверждено

- Наличие бесплатного и стабильного LLM-исполнителя для GitHub Actions.
- Возможность круглосуточной автономной разработки без ручного запуска или внешнего бесплатного лимита.
- Полное текущее состояние production Mini App и поведение на реальном iPhone Telegram WebView.

Обновлять этот файл после каждого существенного аудита, релиза или изменения инфраструктуры.


---

## Срочный цикл UI-редизайна — 2026-11-19, EKB (UTC+5)

### Референсы изучены
- Walt: публичная карточка и скриншоты Mini App — https://tg.app/apps/wallet-1/ ; подтверждено позиционирование Walt как crypto Mini App в Telegram, бывший Wallet. Скриншоты доступны на странице каталога.
- Mira: официальный продуктовый сайт — https://mira.tg/ ; изучены паттерны AI-agent hub и делегирования задач.
- Gemini Neural Expressive: официальный анонс Google от 2026-05-19 — https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/ ; подтверждены динамическая выразительная визуальная система, анимации, haptics и более структурированные ответы.
- Telegram Mini Apps: https://core.telegram.org/bots/webapps ; учитывать актуальные themeParams, themeChanged, safeAreaInset/contentSafeAreaInset, viewportStableHeight, BackButton и нативные методы цвета шапки/фона.

### Фактическое состояние main на момент аудита
- Mini App находится в `miniapp/web/`; активная оболочка — `index.html`, основные UI-слои — `kripto-guru-ui.css` и `kripto-guru-ui.js`.
- В коде уже есть переключатель DEMO/AI/LIVE, тема light/dark/system, профиль, нижняя навигация, экран агентов, AI Companion и market chart. Их нельзя переписывать вслепую.
- LIVE в текущем HTML выключен до проверки полного торгового контракта. AI Trading должен оставаться paper-only.
- В CSS обнаружены остаточные жёстко заданные светлые поверхности и старые размеры/радиусы; нужна проверка согласованности по всей системе.
- PR #179 — ранний ограниченный CSS token/dark baseline, не считать готовым полным редизайном.
- PR #191 уже merged: Gemini-backed AI Companion backend. Это не означает, что все желаемые функции Gemini UI уже реализованы.
- PR #333 — handoff-only по issue #326; LIVE selector task остаётся заблокированной зависимостями.

### Поставлены задачи с дедлайном 2026-11-19 23:30 EKB
- #444 Team B / FRONTEND: первый премиальный iPhone-first инкремент Wallet/theme-safe layout. Scope ограничен CSS и максимум одним HTML-файлом.
- #445 Team A / ANALYST: фактическая матрица «кнопка → UI handler → API/backend capability → статус».
- #446 Team C / QA: независимая мобильная регрессия 360/375/390/430 px, темы, safe areas, клавиатура и BackButton.

Задачи помечены `agent-ready`, `agent-priority` и team labels. События GitHub Actions созданы; фактическое назначение подтверждать только по lease/comments и workflow logs. Не выдавать queued/pending за начатую работу.

### Ограничения и безопасность
- Не подключать платные API/сервисы.
- Не выполнять реальные ордера, close, переводы или изменения Walt account.
- Не включать AI live execution; AI Trading остаётся paper-only.
- Не выполнять merge и production deploy в рамках этого цикла.
- Не считать скриншотную/preview-проверку физическим тестом на iPhone Telegram WebView.
- Временные отметки и дедлайны писать в Asia/Yekaterinburg (UTC+5).


### Обновление — 2026-11-19 23:18 EKB
- Агентские попытки: #444 завершилась `no-safe-patch`; #445 и #446 завершились отказом валидатора из-за завышенного вердикта при непроверенных пунктах. Handoff PR #451, dispatch packets #447/#449/#450 не являются реализацией.
- Чтобы не терять окно, подготовлен ручной CSS-only implementation PR #452 (`design/premium-wallet-stage1-20261119-ekb`): wallet islands, mode-specific DEMO/ИИ accents + aura, 4-tab floating navigation, safe-area spacing, reduced-motion. DOM, handlers, API и торговая логика не менялись.
- PR #452: GitHub Actions typecheck/tests и clean UI screenshots запущены; до завершения CI и просмотра артефактов не считать принятым. Физический iPhone Telegram WebView не проверен.
- Дедлайн задач скорректирован на 2026-11-19 23:30 EKB по 20-минутному окну владельца.
- LIVE остаётся disabled; AI paper-only. Merge/deploy/реальные торговые операции не выполнялись.
