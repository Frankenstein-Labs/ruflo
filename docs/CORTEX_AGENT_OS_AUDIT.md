# CORTEX Agent OS — Initial Repository Audit

**Status:** preliminary, documentation/package metadata review only  
**Target repository:** `Frankenstein-Labs/ruflo`  
**Audit branch:** `cortex-agent-os-audit`  
**Rule:** this document does not claim that the full runtime, agent execution, or benchmarks have been tested.

## Mission

Evolve the existing Ruflo codebase into **CORTEX Agent OS**, an autonomous software-engineering system that can understand a repository, plan work, coordinate specialized agents, edit files, run commands and tests in an isolated environment, recover from failures, and report verifiable outcomes.

The project should build on existing working components rather than replace them with a new UI or a generic scaffold.

## Initial findings

### Existing foundation

The root README describes Ruflo as an agent orchestration harness for Claude Code and Codex, with CLI and MCP entry points, agent swarms, memory/learning integrations, model-provider routing, plugins, federation, and security controls.

The root `package.json` identifies the package as `claude-flow` version `3.56.10`, with a TypeScript/Node.js codebase, Vitest tests, build scripts, MCP-related workspace packages, and a declared MIT license. Its repository, homepage, and issue URLs still point to `ruvnet/claude-flow`, so branding and package identity need a deliberate migration plan rather than blind global replacement.

The root `docs/STATUS.md` describes a prior snapshot (`ruflo@3.10.2`, dated 2026-05-25) and records test counts for that snapshot. These figures must not be treated as proof of the current branch's health; run the present test suites and regenerate the capability inventory before making readiness claims.

### Important limitations of this first pass

- This is a preliminary audit of README, package metadata, and the status document, not a complete source-code or security audit.
- No build, unit test, integration test, live model call, sandbox execution, or benchmark was run during this pass.
- Feature descriptions in documentation are claims to verify against implementation and tests.
- An orchestration harness is not itself a foundation model. Provider availability, credentials, latency, and cost will affect actual agent behavior.

## Proposed architecture direction

1. **Mission API and durable task state:** represent user goals as explicit tasks with acceptance criteria, budgets, deadlines, cancellation, and resumable state.
2. **Orchestrator:** decompose goals, select agents, enforce dependency ordering, manage retries, and stop loops when budgets or policies are reached.
3. **Specialized agents:** researcher/repository analyst, architect/planner, coder, test engineer, reviewer, and security auditor.
4. **Tool/runtime boundary:** scoped filesystem access, allowlisted commands, isolated execution, timeouts, resource limits, and captured stdout/stderr/exit codes.
5. **Repository workflow:** baseline commit, isolated worktree/branch, diff inspection, tests, and pull-request-ready output; never overwrite the user's default branch automatically.
6. **Memory and evaluation:** persist task summaries and validated lessons with provenance; do not treat unverified model-generated conclusions as facts.
7. **Provider abstraction:** configurable hosted and local models, with explicit provider selection, secrets handling, fallback rules, and per-task cost tracking.
8. **Observability and human control:** structured events, traceable tool calls, approval gates for destructive/network/spending actions, and a reliable stop/cancel control.
9. **Evaluation:** a reproducible repository-task benchmark measuring task success, test pass rate, regressions, time, token/cost usage, and human interventions.

## Next audit steps

- Inventory the repository tree, workspaces, entry points, agent definitions, MCP tools, orchestration code, memory adapters, model-provider interfaces, and runtime/sandbox implementation.
- Establish the current branch/commit and clean working baseline; run the documented build, unit, integration, and security tests where feasible.
- Trace one small end-to-end task through planning, tool invocation, filesystem changes, test execution, and final reporting.
- Identify security boundaries, especially shell execution, path traversal, prompt injection, credentials, network access, and untrusted repository content.
- Record verified capabilities separately from planned or documentation-only capabilities.
- Only after this audit, propose the smallest end-to-end improvement and add regression tests.

## Non-goals for the first milestone

- Do not rewrite the entire codebase.
- Do not claim superiority to Devin without a fair, repeatable benchmark.
- Do not run paid training, publish packages, deploy production services, or make destructive/irreversible changes without explicit authorization.
- Do not remove upstream attribution or license notices; branding and legal metadata changes require careful, consistent treatment.

## Initial acceptance criteria

The first implementation milestone should demonstrate one bounded coding mission that can: inspect an authorized repository, produce a plan, make a small change on an isolated branch/worktree, run relevant tests in a constrained runtime, inspect its own diff, and return a truthful report including failures. The test suite must cover cancellation, tool errors, retry limits, permissions, and prevention of writes outside the authorized workspace.

## Implementation progress

The CORTEX runtime now exists in `v3/src/cortex/` and is exercised by the tests
in `v3/__tests__/cortex/`. What is implemented, and what remains, are separated
below so that no claim outruns its evidence.

### Implemented and tested in this repository

- **Ten SDK adapters behind one contract** (`CortexSdkAdapter`), one per
  functional slot, with real package versions recorded in
  `docs/CORTEX_SDK_REGISTRY.md`. Each adapter defers its import until
  `isAvailable()`/`run()`, so a missing package degrades to an honest
  `available: false` instead of a crash.
- **Registry honesty guards:** a status above `identified` must name a concrete
  pinned version, `source` must be `https://`, and a capability may only have one
  SDK. See `runtime/registry.ts`.
- **Orchestrator:** bounded concurrency, per-task deadlines enforced by the
  orchestrator rather than trusted to the adapter, cooperative cancellation,
  dependency ordering with cycle detection, and failure isolation so one broken
  SDK does not fail the batch. See `runtime/orchestrator.ts`.
- **Security core:** fail-closed permission policy, redaction, numeric clamping,
  path-containment checks, and safe error messages. See `security.ts`.
- **Isolated workspaces:** one Git branch plus worktree per task, with unique
  paths, concurrency limits, and no reuse of another task's directory. See
  `runtime/workspace.ts`.
- **OpenHands integration:** the swarm (ten specialist roles), a real Git
  worktree provisioner, and a bridge that maps CORTEX capabilities onto swarm
  roles. A task is only reported verified when an independently injected
  verifier passes. See `runtime/swarm.ts` and `src/openhands/`.

### Verified behaviour

The focused suites pass on the audit branch: `__tests__/cortex/` plus the three
`__tests__/integration/openhands-*.test.ts` files, 96 tests in total.

### Still an integration gate, not yet claimed

- No live Agent Server has been exercised; the OpenHands HTTP contract is tested
  against a controlled `fetch` implementation, not a running deployment.
- The result verifier that checks a real diff against acceptance criteria is
  injected by the caller; a production verifier is not yet implemented.
- Merge coordination, server-side model-profile selection, a vulnerability feed,
  and the Cloud IDE front-end are not implemented. The IDE view model exists
  (`runtime/ideSnapshot.ts`) but no UI consumes it yet.

The two API-level bugs found while writing the adapter tests — Vitest's
`children` collection and CycloneDX's positional `Component` constructor plus
string-returning serializer — are the reason every adapter is exercised against
its installed package rather than against a hand-written mock.

