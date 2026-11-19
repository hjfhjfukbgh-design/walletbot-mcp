# Kripto Guru — operations work log
## 2026-11-19 (Екатеринбург, UTC+05:00)

### 23:58 — AI worker failure analysis
- Reviewed failed role-worker executions for Issues #445 and #446 (Runs 44585658746 and 44585648899).
- Both dispatchers successfully generated task packets (PR #449 and PR #447), but specialist analysis failed at the evidence guard: the model marked items NOT VERIFIED while also returning PASS/ACCEPTED.
- The guard correctly rejected the overclaim. Root cause: no deterministic downgrade/correction path, so a usable partial report was discarded and issue was marked blocked.
- Added a deterministic normalizer in `.github/workflows/role-worker.yml`: when unverified items coexist with an optimistic verdict, it rewrites the verdict to PARTIAL, while preserving mandatory scope-row validation and the final anti-overclaim guard.
- No AI calls were triggered by this fix; no secrets were read; no paid API usage, real trades, merge or deploy.
- Validation pending: workflow YAML/runtime execution has not yet been exercised; a future agent run would call Gemini API and must only be attempted after confirming zero-cost quota/limits.


## 2026-11-20 (Екатеринбург, UTC+05:00)

### 01:20–01:34 — free-quota worker cycle and queue repairs
- CEO confirmed that available Gemini usage is free-tier quota and authorized using it aggressively; CEO will manage any future API-key rotation. No secrets were read or changed by the worker.
- Re-enabled Issues #445 (ANALYST) and #446 (QA). The first retries confirmed Gemini calls were reaching the provider; Issue #446 was rejected by the evidence guard, not by quota exhaustion.
- Merged PR #457, then PR #462. PR #462 extracts scope/verdict parsing into `scripts/agent-worker-guard.mjs`, fixes Russian headings and verdict parsing, passes the full Issue body into the model prompt, and adds Vitest coverage. CI run 44609281420 passed; deploy skipped.
- After PR #462, Team A and Team C produced report-only drafts PR #463 and #464. They remain REVIEW/PARTIAL, not accepted: the analyst draft still contains unsupported UI references, and the QA draft did not initially account for the latest screenshot run.
- Closed stale PR #455 and Issue #192. The old task incorrectly required hiding navigation on the entire Companion screen; current contract is nav visible on Companion home and hidden only while keyboard is open or on trading subscreens.
- Screenshot workflow 44608357999 failed at `capture-clean-ui.mjs:325` because PR #455 hid the nav on Companion home. The CSS patch was not merged.
- Investigated the remaining Telegram BackButton failure in PR #453. Root cause identified in the test harness: Telegram SDK URL is versioned with `?65`, while Playwright intercepted only the exact URL without query. Updated interception to `**/telegram-web-app.js*` on the PR #453 branch. Screenshot workflow 44610413221 is running; no pass is claimed yet.
- Opened PR #465 to validate cited file paths, selectors, and API routes against the actual source context, add line-numbered context, and add tests. First CI run 44610331740 failed because the new validator regexes were over-escaped; follow-up correction is on the same PR branch and awaits CI.
- No production deploy, no live trades, no live position changes, no account changes, and no billing-enabled services.
