# Backend agent MVP

This is the first bounded LLM worker for Kripto Guru.

## Current capability
- Runs only on manual `workflow_dispatch`.
- Uses the repository secret `GEMINI_API_KEY`.
- Calls the already verified `gemini-3.5-flash-lite` model once per run.
- Reads a small allowlist of backend and governance files.
- Produces a Russian analysis report under `team/reports/`.
- Pushes the report to a separate run-specific branch and opens a draft PR.

## Explicit limitations
- Report-only: it does not edit application source code.
- No schedule, issue polling, automatic task pickup, merge, deployment, or LIVE trading.
- A generated report is untrusted work product and requires human review.
- CI/test status is not inferred from the report.

## Run
GitHub → Actions → **Backend agent (manual, report-only)** → Run workflow.
The default task audits the backend and asks for one evidence-based next step.
