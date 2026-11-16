# Kripto Guru — AI Agent Coordination

This file is the shared task mailbox for the two ChatGPT agents.

## Roles
- **LEAD (ChatGPT in the primary account):** sets priorities, writes tasks, reviews diffs/tests, gives corrections, and asks the owner about important product/security decisions.
- **EXECUTOR (ChatGPT in Safari / second account):** reads this file and the latest PR discussion before acting, implements the current task on a separate working branch, reports results, and waits for review.
- **OWNER:** approves product decisions and explicitly authorizes merge/deploy.

## Mandatory work loop
1. At the start of every session, read this file and the latest messages in the coordination PR.
2. Follow only the latest explicit `[LEAD → EXECUTOR]` instruction.
3. If blocked or a material decision is needed, post `[EXECUTOR → LEAD]` with the question and stop that part of the work.
4. Work only on a dedicated feature/fix branch. Never commit directly to `main`.
5. Open/update a PR and post a report with changed files, tests and exact results, commit SHA, PR URL, remaining risks.
6. The LEAD reviews and replies in the PR. Read the review and either fix the requested items or wait for the next task.
7. No silence is approval. Never merge or deploy unless the OWNER explicitly authorizes it.

## Safety / project constraints
- Project: `hjfhjfukbgh-design/walletbot-mcp`.
- Product: Kripto Guru Telegram Mini App, Russian UI, DEMO only; LIVE stays locked.
- Budget: zero. Do not add paid APIs/services.
- Do not change `MINIAPP_URL`, Telegram Menu Button, Cloudflare configuration, production settings, or deployment workflow without explicit OWNER approval.
- Never publish tokens, secrets, credentials, or personal data in GitHub.
- Do not claim perfect operation without actual testing in Telegram WebView on a real device.
- Keep `main` unchanged until the OWNER authorizes merge.

## Message format
Use these prefixes in PR comments:
- `[LEAD → EXECUTOR]` — task or review corrections.
- `[EXECUTOR → LEAD]` — status, findings, test report, or blocker.
- `[OWNER DECISION]` — explicit owner decision.

## Current task
[LEAD → EXECUTOR]

Continue the stabilization task already specified by the lead in the primary ChatGPT conversation:
- P0: safe Telegram SDK/bootstrap and localStorage access.
- P0: one shared contracts loader with in-flight deduplication, timeout, retry, force refresh, and stale-response protection.
- P0: favorites UI states loading/ready/empty/error with retry.
- P1: API helper timeout and robust network/HTTP/JSON/abort errors; ensure state/demo requests cannot hang.
- P1: inspect mobile viewport, safe-area, fixed bottom navigation and scroll behavior without arbitrary padding changes.
- Verify tests, DEMO-only behavior, LIVE locked, and no changes to protected production settings.

First report what branch/PR already exists and what work has already been completed. Do not duplicate completed changes. Keep all work on a separate implementation branch and submit a PR for review. Do not merge or deploy.

## Coordination limitation
This file is a persistent mailbox, not a live agent connection. GitHub does not wake a ChatGPT browser session or make it run continuously. The executor must open/check the coordination PR when resuming its session. The lead can review and reply when the PR activity is brought into the lead's working context.
