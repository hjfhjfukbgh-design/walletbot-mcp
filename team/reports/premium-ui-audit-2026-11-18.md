# Kripto Guru — premium UI audit

**Дата:** 2026-11-18  
**Основа:** read-only review of `main`; файлы и runtime не менялись.  
**Уровень доказательств:** статический аудит исходников. Физический iPhone / Telegram WebView не проверялся.

## Executive verdict

Текущий Mini App — рабочая основа торгового интерфейса, но пока не premium fintech product. Главный визуальный долг — не палитра сама по себе, а отсутствие цельной композиционной системы: интерфейс собран из последовательных локальных CSS-переопределений, а продуктовые режимы и AI-направления ещё не выражены в структуре экранов.

## Что реально существует

### Экранная карта

В `miniapp/web/index.html` присутствуют:
- нижняя навигация: Кошелёк, Торговля, Доход, Бонусы;
- основные sections: wallet, trading, income, bonuses;
- отдельные subscreens: asset detail, trade ticket;
- overlays: leverage modal, trade confirmation;
- asset detail содержит chart placeholder/container, timeframe controls, details/history и LONG/SHORT actions;
- ticket содержит margin, leverage, volume, available balance, preview и DEMO confirmation.

В DOM нет экранов AI Companion, AI Trading, AI account, strategy dashboard или decision journal. Нельзя показывать их как уже работающие.

### Текущий визуальный baseline

В `miniapp/web/kripto-guru-ui.css`:
- root palette светлая: `--kg-bg:#f0f0f6`, белые карточки, серо-чёрный текст, синий акцент;
- базовый радиус и тени существуют, но визуальная система строится вокруг плоских белых карточек;
- typography использует system font, но нет единой шкалы размеров/line-height/weight;
- tabular numerals применяются к отдельным котировкам/балансам, а не как системное правило;
- safe-area bottom учитывается, однако верхняя safe area и динамическая высота экранов требуют отдельной проверки на устройстве.

### Конкретный CSS debt

Статический подсчёт повторных селекторов показывает:
- `.kg-ticket-actions` — 6 определений;
- `.kg-ticket-check` — 6;
- `.kg-ticket-amount` — 5;
- `.kg-ticket-preview` — 5;
- `.kg-ticket-heading` и `.kg-ticket-available` — по 3;
- `@media(max-height:700px)` — 5 отдельных блоков;
- `#kg-main`, `.kg-favorite`, `.kg-chart-card`, `.kg-timeframes`, `#kg-asset-screen` и другие также переопределяются.

В хвосте файла встречаются поздние overrides и `!important` для ticket composition, asset padding и wallet spacing. Это увеличивает риск каскадных регрессий: новое изменение может визуально работать только из-за порядка объявления. Перед масштабным редизайном нужен consolidation pass, а не ещё один слой overrides.

## Рекомендуемый визуальный язык

Направление: **precision instrument / premium market studio**. Не копировать Walt и не делать типичный шаблон «карточка на карточке».

### Токены — стартовая спецификация

| Token | Рекомендация |
|---|---|
| Background | глубокий нейтральный графит, не чистый чёрный |
| Surface 1 | поднятая поверхность для основных панелей |
| Surface 2 | более светлая поверхность для вложенных контролов |
| Text primary | почти белый, высокий контраст |
| Text secondary | приглушённый холодный серый |
| Accent | один узнаваемый электрический синий / ледяной циан |
| Positive / negative | зелёный и красный только для рыночного смысла |
| Border | тонкий контур с низкой непрозрачностью |
| Radius | 10 / 16 / 22 / 28 px; избегать случайных значений |
| Spacing | 4 / 8 / 12 / 16 / 20 / 24 / 32 px |
| Motion | 140–220 ms, reduced-motion aware |
| Numbers | tabular numerals для цены, PnL, баланса, объёма и плеча |

Цвета должны иметь семантические имена, а не использоваться напрямую по всему CSS. DEMO, LIVE и AI должны иметь разные статусные маркеры, но одну систему компонентов. LIVE остаётся заблокированным, если нет отдельного разрешения и подтверждённой защиты.

## Экранные решения

1. **Кошелёк / Home:** баланс и режим счёта как главный фокус; быстрые действия вторичны; ниже — компактный market pulse, избранное и последние события. Не занимать первый экран второстепенными «попробуйте» карточками.
2. **Markets:** плотный, но читаемый список с поиском, фильтрами, избранным, ценой и изменением; единые строки и точность цены из contract metadata.
3. **Asset / Chart:** график как главный объект; цена, изменение, таймфреймы, market stats и торговые уровни должны иметь чёткую иерархию. Нужны loading/stale/error состояния.
4. **Trade ticket:** side selector LONG/SHORT, margin, leverage, estimated notional, fees, slippage, liquidation estimate, TP/SL и доступный баланс. До подтверждения показывать полный preview; не прятать важный риск в мелкий текст.
5. **Positions:** список открытых позиций с mark, entry, unrealized PnL, margin, leverage, TP/SL и freshness. Закрытие — отдельное подтверждение.
6. **AI Companion:** отдельный полноценный chat workspace, а не плавающая кнопка поверх терминала; список диалогов, универсальный composer, контекстные вложения и явный индикатор режима ответа.
7. **AI Trading:** отдельный workspace со своим AI paper balance, equity curve, стратегии, риск-профиль, открытые позиции, журнал решений и метрики. Не смешивать с обычным DEMO balance.

## Компонентные состояния — обязательны

Для каждого интерактивного компонента: default, pressed, focused, disabled, loading, empty, error, success, stale/offline. Для торговых данных stale — самостоятельное состояние, а не просто маленький текст. Для котировок и PnL использовать tabular numerals; для доступности — видимый focus и достаточные touch targets (ориентир 44×44 px).

## Рекомендуемый implementation backlog

1. **KG-UI-01 — Design tokens & CSS consolidation:** заменить ad-hoc overrides на tokens, сгруппировать media queries, устранить повторные определения ticket/chart/nav.
2. **KG-UI-02 — App shell & navigation:** единый shell, safe-area handling, режимные маркеры DEMO/LIVE/AI, адаптация 320–430 px и малой высоты.
3. **KG-UI-03 — Market & chart system:** market rows, asset header, chart frame, timeframe controls, stale/loading/error states, единый price formatter.
4. **KG-UI-04 — Trading surfaces:** ticket, positions, leverage/confirmation modals, риск-preview, accessibility/touch sizing.
5. **KG-UI-05 — AI workspaces:** Companion и AI Trading экраны с честными disabled/empty states до готовности backend.

## Acceptance / verification

- Проверить 320, 360, 390, 430 px и малую высоту экрана.
- Проверить safe areas, scroll containers, fixed bottom nav, keyboard resize и Telegram WebView.
- Снять скриншоты каждого ключевого экрана и сравнить до/после.
- Запустить typecheck и тесты после каждого узкого PR.
- Физический iOS Telegram WebView sign-off — отдельный ручной gate; не считать screenshot workflow его заменой.
