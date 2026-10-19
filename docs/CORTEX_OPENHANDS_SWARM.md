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

### 3. Merge coordinator (next phase)

After tasks are independently verified, a coordinator must check dependency order, rebase or cherry-pick into an integration branch, detect conflicts, rerun the full test suite, and request human approval before merging into a protected branch. Do not automatically merge unverified agent output.

### 4. Operational controls

- Keep OpenHands disabled until a trusted Agent Server and workspace boundary are configured.
- Keep provider credentials in a server-side secret manager.
- Use HTTPS for remote servers and authenticated access.
- Apply per-task deadlines, iteration limits, concurrency limits, audit logs, and cancellation.
- Do not let user-controlled prompts choose arbitrary host paths.
- Treat agent output, repository files, and tool responses as untrusted input.

## Current verification status

The swarm implementation and focused tests have been added to the branch. They have not been executed in this session. This is not yet an end-to-end working service: a real workspace provisioner, real diff/test verifier, server profile selection, merge coordinator, and live Agent Server validation remain integration gates.

## References

- https://github.com/OpenHands/software-agent-sdk
- https://docs.openhands.dev/sdk
- ./CORTEX_OPENHANDS_RUNBOOK.md
