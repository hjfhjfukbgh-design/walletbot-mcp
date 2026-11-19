# ANALYST — фактическая capability matrix Mini App (#445)

- Режим: анализ, исходники не изменялись.
- Проверены текущие main-файлы: index.html, kripto-guru-ui.js, kripto-guru-api.js, src/index.ts, src/api.ts, src/companion.ts и тесты.
- Активный UI — новый Mini App в `miniapp/web/index.html`; старый `app.js` не использован как доказательство для активных обработчиков.
- Статус отчёта: **PARTIAL**. Матрица отражает обнаруженные связи кода, но не заменяет полный runtime E2E на реальном Telegram WebView.

## Матрица действий [S1]–[S31]

| ID | Экран / действие | Selector | UI handler | Client API → backend route | Evidence / статус |
|---|---|---|---|---|---|
| [S1] | Открыть профиль | `#kg-wallet-profile` | `openProfile`, bind: `kripto-guru-ui.js:L901-L935, L1042` | Локальный sheet; route нет | PARTIAL — UI handler есть, backend не нужен; нет отдельного e2e assertion. |
| [S2] | Выбрать DEMO | `#kg-profile-mode-switch [data-profile-mode=demo]` | `selectProductMode`: `kripto-guru-ui.js:L1028-L1040, L1053` | `productMode.set` → POST `/api/product-mode`; GET `/api/state` | PASS — route: `src/api.ts:L60-L64`; mode tests: `test/api.test.ts:L120-L155`. |
| [S3] | Выбрать ИИ | `#kg-profile-mode-switch [data-profile-mode=ai]` | `selectProductMode` | `productMode.set` → POST `/api/product-mode`; paper status GET `/api/ai/paper/status` | PARTIAL — AI PAPER mode и ledger controls есть; AI strategy runner/автоторговля не реализованы. `src/api.ts:L34-L36,L60-L64`. |
| [S4] | Выбрать LIVE | `#kg-profile-mode-switch [data-profile-mode=live]` | Disabled в HTML; `selectProductMode("live")` возвращает блокирующее уведомление: `kripto-guru-ui.js:L1028-L1032` | Нет UI request; отдельный manual LIVE API существует, но не доступен через этот selector | PASS (fail-closed UI) — `index.html:L206`; screenshot harness `capture-clean-ui.mjs:L156-L164`. |
| [S5] | Быстрый переход в Торговлю | `#kg-wallet-quick-actions [data-wallet-shortcut=trading]` | delegated handler: `kripto-guru-ui.js:L1063` | `markets.list` → GET `/api/contracts` | PARTIAL — route есть `src/api.ts:L76-L80`; mock screenshot covers trading/catalog, not production provider. |
| [S6] | Быстрый переход в Позиции/историю | `#kg-wallet-quick-actions [data-wallet-shortcut=income]`, `#kg-wallet-positions-all` | `setScreen`, `loadWallet`, `loadHistory`: `kripto-guru-ui.js:L331-L435,L1047-L1048,L1063` | `wallet.get` GET `/api/demo`; `history.list` GET `/api/demo/history` | PASS (API path) — `src/api.ts:L36-L40`; test suite green in run 44630321694. |
| [S7] | Быстрый переход в Агенты | `#kg-wallet-ai`, `[data-wallet-shortcut=agents]` | `setScreen`, `loadAiPaperSummary`: `kripto-guru-ui.js:L99-L123,L959-L1015,L1061-L1063` | `aiPaper.status` GET `/api/ai/paper/status` | PASS (paper status) — `src/api.ts:L34-L36`; no AI execution runner. |
| [S8] | Виртуальный переход DEMO ↔ AI | `[data-wallet-shortcut=virtual-transfer]`, `#kg-agents-open-funding` | Переключает AI mode и фокусирует amount input: `kripto-guru-ui.js:L1062-L1063` | Сам shortcut route не вызывает; перевод выполняется S22/S23 | PARTIAL — navigation есть, сам transfer требует отдельного действия. |
| [S9] | Открыть/закрыть поиск рынка | `#kg-search-open`, `#kg-search-close` | bind: `kripto-guru-ui.js:L1123-L1124` | При открытии загружается all filter: `markets.list` GET `/api/contracts` | PASS (UI + route) — `src/api.ts:L76-L80`. |
| [S10] | Категории Crypto/Futures | `.kg-category[data-category]` | `loadCategory`: `kripto-guru-ui.js:L230-L256,L1122` | `markets.list` GET `/api/contracts` | PASS (route); доступные категории ограничены crypto/futures в `kripto-guru-api.js:L162-L190`. |
| [S11] | Открыть карточку актива | `[data-open-market]` | delegated click → `openAsset`: `kripto-guru-ui.js:L574-L615,L1141-L1150` | `market.get` → GET `/api/contracts` + GET `/api/price`; candles GET `/api/chart`; history GET `/api/demo/history` | PASS (кодовые связи) — wrappers `kripto-guru-api.js:L162-L224`; routes `src/api.ts:L38-L40,L76-L90`. |
| [S12] | Добавить/убрать избранное | `[data-toggle-favorite]`, `#kg-asset-favorite`, `#kg-edit-favorites` | `renderFavorites`, delegated click, asset favorite: `kripto-guru-ui.js:L138-L150,L1141-L1155` | LocalStorage; backend route нет | PASS (local-only) — тест API не нужен; persistence ограничен текущим браузером. |
| [S13] | Переключить timeframe | `#kg-timeframes [data-interval]` | `loadCandles`: `kripto-guru-ui.js:L635-L650,L1156` | `market.candles` GET `/api/chart?market=…&interval=…` | PASS (кодовая связь) — `kripto-guru-api.js:L215-L224`; `src/api.ts:L80-L90`. |
| [S14] | Long-press crosshair / OHLC | `#kg-chart` | pointer handlers + candle renderer: `kripto-guru-ui.js:L480-L572` | Нет route; вычисление из загруженных свечей | PASS (mock UI contract) — screenshot workflow 44629128298; реальный iPhone touch ещё не проверен. |
| [S15] | Выбрать LONG | `#kg-long` | `openTicket("long")`: `kripto-guru-ui.js:L671-L704,L1157` | На выборе только UI; preview выполняется S17 | PASS (UI handler); AI mode блокирует ручную сделку. |
| [S16] | Выбрать SHORT | `#kg-short` | `openTicket("short")`: `kripto-guru-ui.js:L671-L704,L1158` | На выборе только UI; preview выполняется S17 | PASS (UI handler); AI mode блокирует ручную сделку. |
| [S17] | Изменить маржу и получить preview | `#kg-ticket-margin` | `refreshPreview`: `kripto-guru-ui.js:L706-L727,L1159` | `trade.preview` POST `/api/demo/preview` | PASS (route) — `kripto-guru-api.js:L226-L251`; `src/api.ts:L45-L48`. |
| [S18] | Подтвердить DEMO-сделку | `#kg-ticket-check`, `#kg-trade-confirm` | preview review modal + `confirmTrade`: `kripto-guru-ui.js:L708-L720,L1190-L1197` | `trade.open` POST `/api/demo/open` | PASS (route) — `kripto-guru-api.js:L253-L266`; `src/api.ts:L48-L52`. |
| [S19] | Закрыть DEMO-позицию | `[data-close-position]` | delegated click → `closePosition`: `kripto-guru-ui.js:L721-L727,L1141-L1150` | `trade.close` POST `/api/demo/close` | PASS (route) — `kripto-guru-api.js:L268-L272`; `src/api.ts:L51-L53`. |
| [S20] | Загрузить историю сделок | `#kg-wallet-history-all`, `#kg-asset-history-all`, `[data-open-history]` | `loadHistory`: `kripto-guru-ui.js:L404-L430,L1048,L1189` | `history.list` GET `/api/demo/history` | PASS (route) — `kripto-guru-api.js:L303-L323`; `src/api.ts:L38-L40`. |
| [S21] | Загрузить сводку AI paper | `#kg-agents-screen`, `#kg-wallet-ai` | `loadAiPaperSummary`: `kripto-guru-ui.js:L959-L1015,L1061-L1063` | `aiPaper.status` GET `/api/ai/paper/status` | PASS (paper status) — `kripto-guru-api.js:L382-L397`; no strategy execution endpoint. |
| [S22] | Пополнить AI paper из DEMO | `#kg-ai-paper-fund` | `transferAiPaper("fund")`: `kripto-guru-ui.js:L1000-L1015,L1051` | `aiPaper.fund` POST `/api/ai/paper/fund` | PASS (mocked backend tests) — `kripto-guru-api.js:L376-L381`; `src/api.ts:L62-L64`; `test/api.test.ts:L133-L174`. |
| [S23] | Вернуть AI paper в DEMO | `#kg-ai-paper-withdraw` | `transferAiPaper("withdraw")`: `kripto-guru-ui.js:L1000-L1015,L1054` | `aiPaper.withdraw` POST `/api/ai/paper/withdraw` | PASS (mocked backend tests) — `kripto-guru-api.js:L376-L381`; `src/api.ts:L64-L66`; `test/api.test.ts:L133-L174`. |
| [S24] | Создать новый чат Companion | `#kg-ai-new`, `#kg-ai-new-menu` | `newCompanionConversation`: `kripto-guru-ui.js:L799-L808,L1076-L1077` | Локальное состояние; conversation создаётся при первом send; route до send нет | PASS (local UI); persistence только после сообщения. |
| [S25] | Отправить сообщение Companion | `#kg-ai-form`, `#kg-ai-send` | `sendCompanionMessage`: `kripto-guru-ui.js:L871-L883,L1081` | `companion.send` POST `/api/companion/chat` | PASS (backend tests) — `kripto-guru-api.js:L336-L348`; router `src/index.ts:L31-L32`, `src/companion.ts:L62-L70`; `test/companion.test.ts:L74-L111`. |
| [S26] | Открыть/закрыть историю Companion через BackButton | `#kg-ai-menu-open`, `#kg-ai-menu-backdrop`, Telegram BackButton | `setCompanionMenu`, `handleNativeBack`: `kripto-guru-ui.js:L127-L136,L799-L808,L1078-L1080` | `companion.list` GET `/api/companion/conversations`; limits GET `/api/companion/limits` | PARTIAL — route: `src/companion.ts:L31-L50`; harness uses mocked Telegram WebApp, not physical Telegram WebView. |
| [S27] | Поиск/удаление диалога | `#kg-ai-history-search`, `#kg-ai-history [data-ai-delete]` | local filter + `deleteCompanionConversation`: `kripto-guru-ui.js:L753-L783,L766-L781,L1113-L1118` | Search local; delete `companion.remove` DELETE `/api/companion/conversations/{id}` | PARTIAL — server route: `src/companion.ts:L52-L60`; verify owner-scoped delete and UI interaction on real device. |
| [S28] | Добавить вложение / voice input | `#kg-ai-attach`, `#kg-ai-voice`, `#kg-ai-file-input` | `addCompanionFiles`, `toggleCompanionRecording`, `sendCompanionMessage`: `kripto-guru-ui.js:L831-L870,L1088-L1091` | Files are sent with `companion.send` POST `/api/companion/chat` | PARTIAL — client path exists; browser media permissions, supported codecs and large attachment UX not fully covered by tests. |
| [S29] | Переключить тему light/dark/system | `#kg-profile-theme-select` | `setThemePreference`: `kripto-guru-ui.js:L28-L44,L1052` | LocalStorage; backend route нет | PASS (screenshot tests) — both themes covered in screenshot workflow 44629128298. |
| [S30] | Изменить валюту отображения | `#kg-wallet-currency` | local currency toggle: `kripto-guru-ui.js:L1050`; FX load `L67-L78` | External free FX read; backend route нет | PARTIAL — UI conversion exists; FX provider outage/freshness is not covered by end-to-end tests. |
| [S31] | Поддержка / правовая информация | No active selector found in `index.html:L1-L227` | Handler not found in active `kripto-guru-ui.js` | Backend route not found | NOT FOUND — feature is not implemented in current active Mini App. |

## Security and release notes

- Authenticated API derives Telegram user ID from signed initData before parsing request body: `src/api.ts:L25-L47`; Companion independently validates initData and scopes KV by user: `src/companion.ts:L19-L29`.
- Manual LIVE wrappers exist in `kripto-guru-api.js:L275-L301`; `execute` rejects calls without `confirm === true`. This is a per-order confirmation contract, not AI LIVE session authorization.
- Active UI LIVE selector is disabled and `selectProductMode("live")` returns a blocking message; `src/api.ts` still contains manual LIVE routes. Walt close contract remains NOT VERIFIED under #332; do not unblock LIVE UI or AI LIVE.
- CI: main run 44630321694 passed npm ci, JS syntax, typecheck and npm test; UI screenshot run 44629128298 passed and uploaded artifact 14580123321. Both use mocks/harness; no physical Telegram iPhone WebView sign-off.
- No real Walt write calls, orders, transfers, account mutations, secrets or production deploy were performed.

## Verdict

**PARTIAL.** Core wallet, market, DEMO trade, AI paper balance transfer and Companion code paths have identifiable handlers and routes. The matrix is not a full release sign-off: several UI interactions lack dedicated end-to-end tests; native Telegram WebView and media permissions are unverified; support/legal UI is absent; AI strategy execution is not implemented; LIVE remains gated by #332.

## Backend-only AI PAPER lifecycle note (updated 2026-11-20 EKB)

After this UI capability matrix was merged, internal Durable Object storage operations were added:
- POST/GET /ai/paper/decision(s): tenant-scoped decision ledger, unique per user/tick/symbol.
- POST /ai/paper/position/open and GET /ai/paper/positions: position-open persistence linked to a same-user risk-approved decision, atomic margin/fee/slippage reservation and ledger update.
- These are internal DO routes only. There is still no public Mini App API route, UI action, strategy runner or position-close/PnL operation. Close/PnL is tracked in #572.
- Relevant merges: #566 and #571. This does not change the 31-row active UI matrix above.
