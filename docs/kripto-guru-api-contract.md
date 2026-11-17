# Kripto Guru Mini App API adapter

`miniapp/web/kripto-guru-api.js` publishes the frozen, DOM-independent `window.KriptoGuruAPI` contract. It does not query DOM selectors, render UI, or change styles.

## Loading

Load the adapter after the Telegram WebApp SDK and before the new UI bundle. The legacy `miniapp/web/index.html` is intentionally unchanged; the visual owner can add the script to the new UI shell when integrating it.

## Public contract

- `wallet.get()` → `{ mode: "demo", balanceUsd, balanceMicro, positions[] }`. Raw micro-unit values remain available on `raw`.
- `markets.list({ category: "crypto" | "futures" })` → real Hyperliquid contracts and current public contract fields. Unsupported categories return `{ available: false, reason, markets: [] }`.
- `market.get(symbol)` → contract metadata plus current public quote, product type, max leverage, taker fee, min size and tradeability.
- `market.candles(symbol, interval)` → real OHLC candles for `1m|5m|15m|1h|4h|1d` only.
- `trade.preview({ symbol, side, marginUsd, leverage })` → server-derived quote, min/max margin, volume, entry/estimated exit fee and estimated liquidation price. The preview is informative; the server revalidates every limit at open.
- `trade.open(payload)` and `trade.close(positionId)` → authenticated DEMO Engine endpoints only.
- `history.list()` → timestamped open/close events and persisted ledger equity points. Close PnL is total net PnL after entry and exit fees.
- `capabilities.get()` → explicit availability. LIVE, stocks, funds, IPO and bonuses are unavailable until real sources or mechanisms are approved.

## Security and accounting

- Telegram `initData` is the sole client authentication source; requests send `Authorization: tma ...`.
- The adapter sends no exchange credentials and exposes no LIVE order method.
- Contract eligibility, leverage, fee, slippage, account size and exposure limits are server-owned. `trade.preview` is not an authorization to open; `trade.open` repeats server-side validation immediately before the Engine write.
- Monetary values are normalized to USD for UI display while raw integer/micro values are preserved. The Engine ledger semantics are unchanged: entry fee is charged at open; close cash movement does not charge it a second time; history PnL includes both entry and exit fees.
- Errors reject with `KriptoGuruApiError` and the normalized shape `{ code, message, status, retryable }`.
- Missing quotes/candles produce an explicit error. No mock market data or simulated successful order response is used by this adapter.

## Integration note

The legacy screens remain untouched. The visual owner should load this file before the new UI bundle and consume the methods above rather than reaching into legacy DOM code or duplicating order/risk calculations.