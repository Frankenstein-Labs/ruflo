# CORTEX OpenHands Swarm — Ten Specialized Roles

## Intent

Use Ruflo as the orchestrator and the OpenHands Agent Server / software-agent-sdk as the coding-agent execution backend. CORTEX decomposes a mission into up to ten bounded tasks, runs isolated tasks concurrently, and verifies each result before calling it successful.

**Terminology note:** this implementation does not claim that OpenHands publishes ten separate SDKs. It defines ten specialist roles on top of one configured OpenHands Agent Server integration. The roles can use the same or different server-managed model profiles later, once profile selection is implemented and verified.

## Initial specialist roster

1. **Architect** — decomposition, interfaces, and dependency order.
2. **Frontend** — UI components and user-facing behavior.
3. **Backend** — APIs, services, and business logic.
4. **Data** — schemas, migrations, persistence, and data validation.
5. **Testing** — unit, integration, and regression coverage.
6. **Security** — permissions, secret handling, and threat review.
7. **Documentation** — user and developer documentation.
8. **Performance** — profiling, latency, memory, and resource usage.
9. **Integration** — cross-module compatibility and wiring.
10. **Review** — independent diff review and acceptance criteria.

These are role definitions, not ten independent copies of the same task. Ruflo should assign only non-conflicting work concurrently and express dependencies in the task graph.

## Runtime contract

The file v3/src/openhands/OpenHandsSwarm.ts provides bounded fan-out for 1–10 tasks, a maximum concurrency of 10, unique task IDs, unique branch names, unique workspace directories, and per-task results. A task is reported as verified only if:

- the Agent Server reports execution state finished;
- the injected verifier independently checks the result; and
- that verifier returns passed: true.

A completed conversation is not proof that code is correct. The verifier is not fabricated or silently assumed: the caller must provide a real verifier.

## Required integration services

### 1. Workspace/branch provisioner

Implement OpenHandsWorkspaceProvisioner.prepare() using the deployment's Git and sandbox infrastructure. It must create a real dedicated branch/worktree and a disposable workspace visible to the Agent Server. Merely passing different path strings does not isolate processes or filesystems.

### 2. Result verifier

Implement OpenHandsResultVerifier.verify() to collect the actual diff, check allowed paths, use the project's pinned toolchain, run relevant tests and static checks, and evaluate each acceptance criterion. It must return a failed result if evidence is missing or any required check fails.

### 3. Merge coordinator

Implemented as `CortexMergeCoordinator` (`v3/src/cortex/runtime/merge.ts`).
After the swarm verifies tasks, the bridge commits each verified worktree onto
its branch (`CortexWorkspaceManager.commit`) before releasing it, then the
coordinator integrates the verified branches into one integration branch.

It enforces two invariants:

- a branch is never merged unless its candidate is marked `verified`, so agent
  output that no verifier passed can never reach the integration branch;
- on conflict the merge is aborted and the integration branch is left on the
  last good merge, never a half-applied tree.

It also orders dependencies first (a cycle or an unknown dependency is a hard
error, not a guess), recreates the integration branch from the base ref on each
run so repeated runs do not stack, and rejects unsafe branch names before
touching Git. Tests: `v3/__tests__/cortex/cortex-merge.test.ts` (8 tests on a
real repository).

It does not request human approval and does not push: a reviewer still decides
whether the integration branch is merged into a protected branch.

### 4. Operational controls

- Keep OpenHands disabled until a trusted Agent Server and workspace boundary are configured.
- Keep provider credentials in a server-side secret manager.
- Use HTTPS for remote servers and authenticated access.
- Apply per-task deadlines, iteration limits, concurrency limits, audit logs, and cancellation.
- Do not let user-controlled prompts choose arbitrary host paths.
- Treat agent output, repository files, and tool responses as untrusted input.

## Current verification status

Verified against a real Agent Server on 2026-10-19, not inferred from source.

What was actually run:

- Image `ghcr.io/openhands/agent-server:1.56.0-python` started as a container
  with `SESSION_API_KEY` and an LLM key from the managed proxy.
- `GET /health` returned `{"status":"ok"}`.
- Three tasks (alpha, beta, gamma) were submitted concurrently through the real
  TypeScript stack (`CortexSwarmBridge` -> `OpenHandsSwarm` ->
  `OpenHandsAgentBackend`) and each one finished with an independent verifier
  returning passed: true.
- Each task ran in its own Git worktree on its own branch
  (`cortex/alpha`, `cortex/beta`, `cortex/gamma`). Each agent wrote its marker
  file only in its own worktree; no marker appeared in another task's worktree.
- Three distinct roles ran at once (testing, documentation, security), not three
  copies of one role.
- The bridge committed each verified worktree onto its branch before releasing
  it, and `CortexMergeCoordinator` merged the three verified branches into
  `cortex/integration`. The integration tree contained `alpha.txt`, `beta.txt`
  and `gamma.txt`, with one merge commit per branch.

The runnable proof is `v3/__tests__/integration/cortex-live-swarm.test.ts`. It is
skipped unless `CORTEX_LIVE_AGENT_SERVER_URL` is set, so it never runs in CI
without a server. To run it:

```bash
CORTEX_LIVE_AGENT_SERVER_URL=http://127.0.0.1:8000 \
CORTEX_LIVE_SESSION_API_KEY=<session key> \
CORTEX_LIVE_LLM_API_KEY=<llm key> \
CORTEX_LIVE_MOUNT_HOST_ROOT=/tmp/oh-workspaces \
CORTEX_LIVE_SANDBOX_ROOT=/workspace \
npx vitest run __tests__/integration/cortex-live-swarm.test.ts
```

### Contract facts confirmed against Agent Server 1.56.0

These were observed from the live server and its OpenAPI document, and two of
them contradicted earlier assumptions in this repository:

- `POST /api/conversations` requires `workspace.working_dir` to be an absolute
  path. A relative path is resolved against the server's working directory (`/`),
  which is not the mounted workspace, and fails with `PermissionError`.
- The `agent_settings` object accepts a plain `llm` block
  (`{"llm": {"model", "api_key", "base_url"}}`). Passing
  `agent_settings.agent` as an object is rejected: for `agent_kind: "openhands"`
  the server expects a string agent class.
- The `llm` block is forwarded to LiteLLM, so `model` needs a provider prefix
  (`openai/deepseek-v4-flash`, not `deepseek-v4-flash`), and the key field is
  snake_case `api_key` / `base_url`.
- The server starts a conversation during create unless the initial message sets
  `run: false`. A following `POST /api/conversations/{id}/run` therefore returns
  `409 Conversation already running`. `OpenHandsAgentBackend` previously treated
  that 409 as a fatal submission error and reported a running task as failed;
  it now treats 409 as already-running. See the regression tests in
  `__tests__/integration/openhands-backend.test.ts`.
- Conversation events are read with `GET /api/conversations/{id}/events`; a bare
  `?limit=` query is rejected with 422.

### What is still not done

This is a working multi-agent execution path plus a merge coordinator, not a
finished service. Still open:

- the live run exercised three roles (testing, documentation, security). The
  other seven roles exist as configuration and have not been run live;
- the integration branch is never pushed and no human approval gate is wired
  in; a reviewer still has to decide whether to merge it;
- production secret management for the LLM key (the key is passed per request
  in this local setup).

## References

- https://github.com/OpenHands/software-agent-sdk
- https://docs.openhands.dev/sdk
- ./CORTEX_OPENHANDS_RUNBOOK.md
