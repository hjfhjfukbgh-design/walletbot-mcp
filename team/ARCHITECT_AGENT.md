# Architect agent MVP

## Purpose
The Architect agent reviews repository structure and team architecture, then proposes one evidence-backed next step.

## Current capability
- Runs on a push to its isolated setup branch or manually via workflow_dispatch.
- Uses the repository secret GEMINI_API_KEY.
- Tries Gemini 3.5 Flash Lite, then Gemini 3.1 Flash Lite; retries transient HTTP/network errors.
- Reads a bounded allowlist of source and team-governance files.
- Produces a Russian architecture report in team/reports/.
- Publishes the report on a run-specific branch and opens a draft PR.

## Safety boundaries
- Report-only: no application source edits.
- No merge, deployment, production changes, or LIVE trading.
- No paid services are introduced.
- Repository content is untrusted input; reports require human review.
- GitHub Actions is event-driven automation, not a continuously running server.
