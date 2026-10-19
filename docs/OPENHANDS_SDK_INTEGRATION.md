# CORTEX Agent OS — OpenHands SDK Integration Plan

**Target branch:** `cortex-agent-os-audit`  
**Status:** integration design; implementation and runtime validation are still pending.

## Decision

Use the official [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) as a coding-agent execution backend behind a CORTEX adapter. Keep Ruflo as the orchestration layer and CORTEX as the product policy, mission lifecycle, and evaluation layer.

Do not copy the OpenHands repository into Ruflo, and do not add an unverified package dependency just to claim integration.

## Why this boundary

The OpenHands SDK repository documents Python APIs for agents, conversations, tools and workspaces; an Agent Server with REST/WebSocket APIs; and a browser-compatible TypeScript client. This makes a service/client boundary a better initial fit than attempting to import its Python runtime directly into Ruflo's Node.js/TypeScript process.

Official references:
- SDK repository: https://github.com/OpenHands/software-agent-sdk
- SDK documentation: https://docs.openhands.dev/sdk

Verify current API schemas and supported versions from the upstream docs before implementing the adapter.

## Proposed responsibilities

### Ruflo — orchestration
- Decompose a mission into dependency-aware tasks.
- Assign tasks to specialist roles and manage agent collaboration.
- Apply budgets, retry limits, cancellation, and approval policies.
- Record task events and verified outcomes.

### OpenHands Agent Server — coding execution
- Execute a bounded coding conversation in an authorized workspace.
- Provide supported code-editing and terminal tools.
- Stream or retrieve conversation events through the documented API.
- Run in a disposable container/workspace when configured.

### CORTEX adapter — provider boundary
Create a narrow adapter (suggested name: `OpenHandsAgentBackend`) that:
1. Accepts a validated CORTEX task and workspace descriptor.
2. Starts or resumes an OpenHands conversation using documented SDK/API calls.
3. Translates task status, events, tool failures, and final results into CORTEX's internal event model.
4. Enforces request timeout, cancellation, maximum output/event size, and allowed workspace scope.
5. Returns a structured result with changed files/diff reference, test evidence, errors, and completion status.
6. Never reports success merely because the agent stopped; CORTEX must evaluate acceptance criteria separately.

## First vertical slice

Implement only one bounded task path first:

1. User submits a mission with explicit acceptance criteria.
2. Ruflo creates a task record and chooses the OpenHands backend.
3. The adapter calls a configured Agent Server endpoint using a secret supplied at runtime (never committed).
4. OpenHands works in a disposable workspace or a specifically authorized checkout.
5. CORTEX collects completion events and obtains a diff/result.
6. A verification stage checks the diff and runs permitted tests.
7. The user receives a report stating what changed, what passed, what failed, and what was not checked.

## Configuration

Use environment variables or the project's existing secret/config system. Suggested names are illustrative and should be aligned with existing configuration conventions before coding:

- `CORTEX_OPENHANDS_BASE_URL`
- `CORTEX_OPENHANDS_API_KEY`
- `CORTEX_OPENHANDS_REQUEST_TIMEOUT_MS`
- `CORTEX_OPENHANDS_ENABLED`

Do not log API keys or place credentials in task prompts, Git commits, fixtures, or traces.

## Security requirements

- Default to disabled until explicitly configured.
- Require authenticated transport; prefer TLS for remote Agent Server access.
- Restrict each task to an explicit workspace and prevent path escape.
- Use disposable execution environments with resource and time limits.
- Require approval for destructive operations, publishing, deployment, paid compute, or external side effects.
- Treat repository files, issue descriptions, web pages, and model output as untrusted input (prompt-injection boundary).
- Enforce cancellation, retry ceilings, loop detection, and per-task budget limits.
- Keep credentials out of agent-visible environment variables unless strictly required.
- Capture audit events without recording secrets.

## Test plan

Add mocked adapter tests for:
- successful task lifecycle and event translation;
- authentication failure and unavailable Agent Server;
- timeout, cancellation, and retry ceiling;
- malformed or oversized events;
- path/workspace authorization failure;
- incomplete task results and failed acceptance criteria;
- secret redaction in logs.

Add an opt-in integration test against a disposable Agent Server only after local mocked tests pass. Do not require paid model access for the default test suite.

## Acceptance criteria

The integration is ready for a first release only when:
- the adapter uses a documented, version-pinned API/client contract;
- default tests pass without network or paid credentials;
- the integration test demonstrates one bounded repository task end to end;
- the result includes independently verified test evidence and a truthful failure state;
- security boundaries and configuration are documented;
- upstream license and attribution notices are preserved.

## Explicit non-claims

This plan does not mean the SDK has been installed, connected, or executed yet. It does not establish that CORTEX currently surpasses Devin. Those claims require implementation, test evidence, and reproducible comparative benchmarks.
