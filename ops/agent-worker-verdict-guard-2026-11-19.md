# Kripto Guru — operations work log
## 2026-11-19 (Екатеринбург, UTC+05:00)

### 23:58 — AI worker failure analysis
- Reviewed failed role-worker executions for Issues #445 and #446 (Runs 44585658746 and 44585648899).
- Both dispatchers successfully generated task packets (PR #449 and PR #447), but specialist analysis failed at the evidence guard: the model marked items NOT VERIFIED while also returning PASS/ACCEPTED.
- The guard correctly rejected the overclaim. Root cause: no deterministic downgrade/correction path, so a usable partial report was discarded and issue was marked blocked.
- Added a deterministic normalizer in `.github/workflows/role-worker.yml`: when unverified items coexist with an optimistic verdict, it rewrites the verdict to PARTIAL, while preserving mandatory scope-row validation and the final anti-overclaim guard.
- No AI calls were triggered by this fix; no secrets were read; no paid API usage, real trades, merge or deploy.
- Validation pending: workflow YAML/runtime execution has not yet been exercised; a future agent run would call Gemini API and must only be attempted after confirming zero-cost quota/limits.
