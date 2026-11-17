# Kripto Guru Autonomy Engine

## Goal

Turn the current one-task dispatcher MVP into an unattended, resumable AI engineering studio. A user submits a task once; the system decomposes it, schedules specialists, records durable state, resumes interrupted work, validates outputs, and publishes reviewable Draft PRs without requiring the user or ChatGPT to remain online.

This document is an implementation contract, not a claim that the engine is already running.

## Operating model

1. **Intake:** GitHub Issue is the durable task record. A task must include an outcome, scope, acceptance criteria, constraints, and evidence expected.
2. **Planning:** the central orchestrator creates a bounded plan with dependencies and assigns each work item to a team and specialist.
3. **Queue:** each work item has a stable ID, parent Issue, owner, dependency list, attempt count, lease/claim metadata, status, branch, and output links.
4. **Execution:** workers run independently in isolated branches. Independent work may run in parallel; tasks that touch overlapping files or depend on earlier work must be serialized.
5. **Handoff:** completed work is recorded as an artifact and status transition. Downstream agents consume the artifact, not transient runner memory.
6. **Verification:** QA checks the actual diff and runs project checks. Security review is a separate gate for sensitive changes. AI review is advisory and never substitutes for human review.
7. **Recovery:** scheduled reconciliation finds stale claims, expired leases, interrupted runs, failed workers, and ready dependents. It safely requeues only retryable work, with bounded attempts and backoff.
8. **Delivery:** successful work is published as Draft PR. Human approval remains mandatory for merge, deployment, LIVE trading, and any production-affecting action.

## Durable state

GitHub Issues and PRs are the initial zero-cost persistence layer. Do not rely on Actions workspace files, environment variables, or a single workflow run as durable memory.

Recommended labels/statuses:
- `agent-ready`: accepted into the queue.
- `agent-planned`: decomposed into work items.
- `agent-running`: currently claimed by a worker.
- `agent-review`: implementation awaits QA/review.
- `agent-blocked`: needs human input or a dependency.
- `agent-retry`: eligible for bounded retry.
- `agent-done`: acceptance criteria satisfied and evidence attached.
- `agent-dispatched`: legacy MVP state; migrate carefully.

Each work item must record: `task_id`, parent Issue, team, specialist role, status, attempt, max_attempts, created_at, updated_at, claimed_by, lease_expires_at, dependency IDs, touched paths, branch, PR URL, check results, reviewer findings, and next_action.

State transitions must be explicit and validated. A worker must claim a task before acting; a claim must be idempotent and protected against duplicate processing. Expired claims may be recovered by the reconciler.

## Parallelism and conflict control

- Start with a maximum of **three concurrent work items**, at most one per team, until quota use and reliability are measured.
- Each worker gets its own branch and bounded file allowlist.
- The planner must identify likely file overlap before dispatch.
- Work items with overlapping write sets, shared migrations, API contract changes, or unresolved dependencies are serialized.
- Workers must not push to another worker's branch.
- The global queue reconciler uses a concurrency group; individual worker jobs use task-specific concurrency groups.
- Do not spawn 18 simultaneous model calls. Eighteen specialist profiles are a capability registry; concurrency is a separate, bounded control.

## Autonomous operation in GitHub Actions

GitHub Actions is event-driven and scheduled, not a permanently running server. The first implementation should use:
- `issues: [opened, edited, labeled, reopened]` for intake and explicit task readiness;
- a conservative scheduled reconciliation run (initially every 30 minutes, subject to free quota and observed failures);
- `workflow_dispatch` for operator recovery and diagnostics;
- `workflow_run` only where a downstream workflow needs a verified completion event.

The scheduled reconciler must:
1. scan a bounded number of queued tasks;
2. validate dependencies and claims;
3. recover expired/stale work;
4. dispatch only work within concurrency and quota budgets;
5. emit a concise status summary;
6. stop cleanly when there is no eligible work.

Avoid polling every few minutes until actual workload and free-tier limits are measured. If GitHub Actions proves insufficient for long-lived jobs, evaluate a free/low-cost event-driven alternative later; do not silently introduce paid infrastructure.

## Reliability rules

- Maximum 2 implementation attempts per work item initially; no infinite loops.
- Retry only transient infrastructure/model failures. Do not retry policy, scope, permission, or acceptance failures blindly.
- Exponential backoff with jitter; model fallback only to configured free-tier models.
- Preserve full failure reason and run URL.
- If a task repeatedly fails, mark it blocked and request human input.
- A QA rejection creates a bounded repair task linked to the original; it does not overwrite the reviewer report.
- Every stage must be restartable from persisted state.

## Security and permissions

- Treat Issue bodies, comments, generated plans, and model output as untrusted data.
- Secrets remain in GitHub Actions Secrets and must never enter logs, artifacts, prompts that are persisted, Issues, or PR descriptions.
- Use least-privilege workflow permissions and pin third-party Actions to reviewed immutable SHAs before production activation.
- No agent may modify workflow permissions, secrets, branch protection, or its own safety gates.
- No auto-merge, production deploy, LIVE trading, real orders, or funds movement.
- All code changes are isolated Draft PRs and require human review.
- A second-model review is not an independent security audit.

## Rollout phases

### Phase 0 — design and inventory
- Preserve current orchestrator MVP as the baseline.
- Define state schema, transitions, roles, ownership, retry policy, and concurrency contract.
- Identify current workflow gaps and migration risks.

### Phase 1 — durable queue and recovery
- Add issue event intake and scheduled reconciler.
- Add explicit task-state labels/metadata and idempotent claims.
- Add stale-run recovery, bounded retries, and operator diagnostics.
- Keep execution sequential initially.

### Phase 2 — team fan-out
- Expand the role registry to 18 specialist profiles across A/B/C.
- Let planner create multiple dependent work items.
- Run up to three non-conflicting team tasks concurrently.
- Persist artifacts and dependency handoffs.

### Phase 3 — QA repair loop
- Add independent QA work item after implementation.
- Permit at most one bounded repair attempt per finding batch.
- Re-run typecheck/tests and reviewer gate; otherwise block for human review.

### Phase 4 — unattended pilot
- Run against non-production documentation and test tasks first.
- Measure completion rate, retries, quota use, queue latency, and false-positive reviews.
- Only after successful evidence, expand to application-code tasks.

## Acceptance criteria for the autonomy engine

- A task submitted while the owner is offline is discovered and processed by the next scheduled/event-triggered run.
- State survives the end of every Actions run.
- A deliberately interrupted worker is recovered without duplicate PRs or lost work.
- Duplicate triggers do not create duplicate task execution.
- Independent team tasks can run concurrently within the configured cap.
- Conflicting tasks are serialized.
- QA failure produces a bounded repair or a clear blocked state.
- Every task ends in done, blocked, or explicitly retryable with a recorded reason.
- No merge, deployment, LIVE trading, or funds movement can occur automatically.
- Every claimed capability is backed by workflow run links and persisted artifacts.

## Current baseline and known gaps

The current PR #46 orchestrator:
- runs manually or every two hours;
- processes at most one ready Issue per run;
- selects one of six generic roles;
- has no durable work-item/dependency model;
- has no stale-claim recovery or end-to-end retry state machine;
- has no QA repair loop;
- is not active until merged into the default branch.

Therefore the current system is an MVP dispatcher, not yet an unattended multi-team studio. This document defines the next engineering stages without claiming those capabilities already exist.

## Implemented queue recovery MVP (Draft PR)

The queue-recovery branch adds a first persisted lease protocol on GitHub Issues:

- The dispatcher writes a `kg-lease` comment marker with the caller workflow run ID and a 45-minute UTC expiry before invoking the reusable worker.
- The worker has `issues: write` permission and runs an `always()` finalizer. Successful workflows move the Issue from `agent-dispatched` to `agent-done`; failed/cancelled workflows move it to `agent-blocked`. Both write a matching `kg-complete` marker.
- A separate scheduled recovery workflow runs hourly. It scans up to 100 open `agent-dispatched` Issues, finds the lease marker, and returns an expired lease to `agent-ready` only when the matching completion marker is absent.
- Issues without valid lease metadata are skipped for manual inspection. Recovery does not blindly retry failed workers; those are blocked for diagnosis.
- The existing orchestrator schedule remains every two hours. A recovered task is picked up on the next orchestrator run, unless manually dispatched sooner.

This is still a sequential MVP, not the full multi-team autonomy engine. It does not yet decompose one request into dependent work items, fan out three teams, detect file conflicts, or run QA repair loops. It also requires these workflows to be merged into the default branch before GitHub scheduled events can activate. The recovery workflow and worker finalizer must be proven with real Actions runs before claiming end-to-end reliability.

## Multi-team planning MVP (Draft PR)

The parallel-planning branch adds a manual parent-Issue decomposition workflow:

- A planner uses the Team A Gemini key to produce a bounded plan of 1–3 child tasks for teams A/B/C.
- The plan is validated before child Issues are created: allowed roles/teams, required fields, known dependencies, and an acyclic dependency graph.
- Child Issues carry stable task metadata, a team label, a narrow write scope, acceptance criteria, and either `agent-ready` or `agent-planned`.
- Re-running the planner reuses child Issues with matching parent/task-key markers rather than creating a duplicate for the same key.
- The central dispatcher now honors explicit `team-a`, `team-b`, or `team-c` labels rather than always choosing a team from the Issue number.
- A scheduled dependency-unlock workflow promotes a planned child task only after all referenced sibling tasks carry `agent-done`.

Limitations remain material: the current dispatcher still processes only one ready Issue per run, so task decomposition is not yet concurrent execution. The unlocker uses GitHub Issue labels as a completion signal, not proof that a dependency PR was merged or independently accepted. Parallel team fan-out, conflict arbitration, independent QA gates, and a real end-to-end run remain future work. These scheduled workflows are inactive until merged into the default branch.

## Parallel team fan-out MVP (Draft PR)

The fan-out branch adds a scheduled/manual matrix dispatcher:

- It claims up to one `agent-ready` child Issue per team label (`team-a`, `team-b`, `team-c`) in one serialized claim phase.
- Each child Issue must contain the planner's explicit team and role metadata; malformed or unlabelled work is skipped.
- The claim phase writes a per-Issue lease marker before changing its state to `agent-dispatched`.
- A GitHub Actions matrix then invokes up to three reusable role workers concurrently, routing each worker to the matching Gemini secret.
- The legacy single-issue orchestrator shares the same queue-claim concurrency group so it cannot race the matrix claimant.
- Each worker's existing finalizer records success as `agent-done` or failure as `agent-blocked`; the hourly lease recovery remains the fallback for interrupted runs.

This is the first parallel execution path, but it is still an MVP: only one task per team is claimed per run; a single task cannot be split into multiple workers; there is no file-level conflict arbitration across teams yet; and the dependency unlocker treats worker completion as a handoff signal, not human acceptance or merged code. The fan-out and recovery paths need real Actions validation after merge. No automatic merge, deployment, LIVE execution, or funds movement is permitted.
