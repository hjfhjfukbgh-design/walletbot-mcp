# Independent QA review — PR #630 DEMO/LIVE and Manual/AI hierarchy

**Reviewed commit:** `a2b21ed8c3af6ef76e0d26357809826a7a6ad4a7`  
**PR:** [#630](https://github.com/hjfhjfukbgh-design/walletbot-mcp/pull/630)  
**Review type:** Read-only code and screenshot review.  
**Status:** PASS with no blocking findings. Telegram iOS WebView remains NOT VERIFIED.

## 1. Scope and validation evidence

PR #630 changes only:
- `miniapp/web/index.html`
- `miniapp/web/kripto-guru-ui.js`
- `miniapp/web/kripto-guru-ui.css`
- `miniapp/web/capture-clean-ui.mjs`

No backend API, trading engine, order execution, wallet, MCP/Walt or LIVE endpoint implementation is changed.

Latest checks for the reviewed commit:
- CI run `44663603942`: **17 test files / 213 tests passed**, typecheck passed; deploy job skipped.
- UI preview run `44663603980`: screenshot capture passed.
- Artifact `14596179558`: 360/375/390/430 viewport previews in light/dark mode.

Screenshots visually inspected:
- `clean-wallet-360x800.png`
- `clean-wallet-dark-360x800.png`
- `clean-wallet-430x932.png`
- `clean-product-mode-ai-360x800.png`
- `clean-product-mode-ai-dark-360x800.png`
- `clean-wallet-agent-360x800.png`

## 2. Acceptance checklist

| Check | Result | Evidence |
|---|---|---|
| Exactly two top-level market modes | PASS | Wallet header shows DEMO and LIVE only. No top-level AI market mode. |
| LIVE remains blocked | PASS | LIVE is disabled and labelled “Скоро · заблокирован”; no LIVE execution path added. |
| Manual/AI are nested methods | PASS | Method selector shows “Ручная” and “AI Piper” under DEMO. |
| AI Piper remains virtual DEMO | PASS | Selector labels it “Автономный DEMO”; session controls state that only virtual funds are affected. |
| Legacy method/account semantics preserved | PASS | UI retains the existing `productMode` method selection; PR does not change backend API contracts. |
| No real trade or wallet writes | PASS | Diff is UI and screenshot harness only; no execution/API changes. |
| Russian visible labels | PASS | Visible session control now says “Остановить AI Piper”; no “AI paper” button text remains in the reviewed wallet UI. |
| Narrow-screen shortcut layout | PASS | Latest 360px screenshot shows “Вирт. перевод” wrapped inside its tile after CSS fix; no text overflow. |
| Light/dark and viewport screenshots | PASS | Artifact contains 360/375/390/430 light/dark previews; inspected representative 360 and 430 captures. |
| Floating navigation and scroll content | PASS | Navigation is intentionally floating over scrollable content; wallet layout retains bottom padding and content can be scrolled. |
| Physical Telegram iOS WebView | NOT VERIFIED | Playwright/browser screenshots do not prove native Telegram iOS behavior. |

## 3. Findings

### No blocking findings

The two-level hierarchy is clear and matches the approved product model:
- DEMO / LIVE are the only top-level market modes.
- Manual / AI Piper are methods within the selected market mode.
- LIVE cannot be activated from this UI.
- AI Piper is explicitly presented as autonomous DEMO, with virtual-account messaging.

### Minor implementation note — future LIVE enablement

The current `marketMode` UI state is intentionally DEMO-only while LIVE is disabled. Enabling LIVE later must be a separate task that connects the market-mode state to a server-owned contract and revalidates Manual LIVE per-order confirmation versus bounded AI LIVE session authorization. This PR does not claim that LIVE is ready.

### Screenshot note

At 360px, the fourth quick-action label initially exceeded its tile. PR #630 now wraps the label into two lines; the latest artifact confirms it fits. The floating bottom navigation overlays the scrollable page by design and is not a fixed-content loss.

## 4. Recommendation

QA acceptance: **PASS** for the current DEMO-only UI hierarchy. No product-code blocker found in this PR.

Keep production deployment disabled. Telegram iOS WebView verification remains a separate, explicit check. This report does not authorize merge or deployment.
