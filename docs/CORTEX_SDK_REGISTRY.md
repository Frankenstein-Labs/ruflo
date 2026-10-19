# CORTEX SDK Registry

**Status:** the ten adapters below are implemented and exercised against the real
packages installed in `v3/node_modules`. Every version and API note in this
document was read from the installed package or its official registry, not from
memory.

## Rule for this registry

A capability may only be claimed at the status recorded here. The registry
(`v3/src/cortex/runtime/registry.ts`) enforces two honesty guards at
registration time:

- a status above `identified` must name a concrete pinned version, not
  `unknown`;
- `source` must be an `https://` URL.

The status ladder is defined in `v3/src/cortex/types.ts` and is ordered; a later
step may only be claimed when the evidence for it exists in this repository.

## Verified versions

All versions were confirmed by reading `node_modules/<pkg>/package.json` on
2026-10-19, and the Python package was confirmed against the PyPI JSON API.

| CORTEX id | Capability | Package | Version | Registry | Licence | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `openhands` | code-execution | `openhands-sdk` | 1.56.0 | pypi | MIT | https://github.com/OpenHands/software-agent-sdk |
| `langgraph` | planning | `@langchain/langgraph` | 1.5.1 | npm | MIT | https://github.com/langchain-ai/langgraphjs |
| `vite` | frontend | `vite` | 8.3.4 | npm | MIT | https://github.com/vitejs/vite |
| `fastify` | backend | `fastify` | 5.12.7 | npm | MIT | https://github.com/fastify/fastify |
| `drizzle` | data | `drizzle-orm` | 0.45.4 | npm | Apache-2.0 | https://github.com/drizzle-team/drizzle-orm |
| `vitest` | testing | `vitest` | 4.1.8 | npm | MIT | https://github.com/vitest-dev/vitest |
| `cyclonedx` | security | `@cyclonedx/cyclonedx-library` | 10.3.0 | npm | Apache-2.0 | https://github.com/CycloneDX/cyclonedx-javascript-library |
| `typedoc` | documentation | `typedoc` | 0.27.9 | npm | Apache-2.0 | https://github.com/TypeStrong/TypeDoc |
| `autocannon` | performance | `autocannon` | 8.0.0 | npm | MIT | https://github.com/mcollina/autocannon |
| `octokit` | review | `@octokit/rest` | 22.0.1 | npm | MIT | https://github.com/octokit/rest.js |

## Integration boundary per SDK

### `openhands` — code execution

CORTEX does **not** import the Python `openhands-sdk` into the Node process. The
Python SDK drives an Agent Server; CORTEX talks to that server's HTTP contract
instead, which keeps the orchestration layer in TypeScript and avoids a
cross-language bridge. The contract CORTEX relies on is:

- `POST` a task to start a conversation and receive its id;
- `GET` the conversation until `execution_status` is `finished`;
- the base URL must be HTTPS unless it is loopback (`http://localhost`, `::1`),
  which is the only place plain HTTP is allowed.

`isAvailable()` is `false` unless the integration is explicitly enabled *and* a
base URL, agent, and allowed workspace root are configured. An unconfigured
OpenHands must never be reported as available.

The workspace boundary is real: `CortexWorkspaceManager` creates one Git branch
plus worktree per task, and `CortexWorkspaceProvisionerBridge` exposes the host
path and the Agent Server mount path as two distinct values, because only the
deployment's mount configuration knows how they correspond.

### `langgraph` — planning

The adapter builds a real `StateGraph` on `@langchain/langgraph` 1.5.1 and
invokes it once per objective, so the plan is produced by the actual graph
runtime rather than assembled in this file. Objective extraction is
deterministic on purpose: an LLM planner belongs behind an explicit model
configuration, not inside an adapter. No model is called here, and the adapter
does not claim a plan was model-generated.

### `vitest` — testing

Verified against `vitest/node` 4.1.8. The adapter calls
`startVitest('test', filters, options)` and reads results from
`vitest.state.getTestModules()`. Two API details matter and were confirmed by
probing the installed package:

- `TestModule.children` is a `TestCollection` **object**, not a function and not
  an array. Passing tests are counted with `children.allTests()`, which walks
  nested suites as well as the module's own tests.
- Vitest always installs a console reporter unless one is supplied, so the
  adapter passes a no-op reporter; otherwise the nested run's output would be
  duplicated into the caller's console.

A run that produces zero test modules, or any failed test, is a failure result.

### `cyclonedx` — security

Verified against `@cyclonedx/cyclonedx-library` 10.3.0. Three API details were
confirmed by probing the installed package and are easy to get wrong:

- `Models.Component` takes **positional** arguments `(type, name, version)`; a
  single options object silently produces a component with no name or version.
- `Component.version` is not applied by the constructor and must be assigned.
- `JsonSerializer.serialize()` returns a **JSON string**, not an object, and
  `licenses` is a repository (`component.licenses.add(...)`), not a constructor
  option.

The BOM records `bomFormat`, `specVersion`, and one entry per dependency with
its version and whether a licence was recorded. A BOM with no components is a
failure result. This adapter produces an SBOM; it does not decide whether a CVE
is exploitable, and no vulnerability feed is configured.

### `autocannon` — performance

Verified against `autocannon` 8.0.0. The callable export `autocannon()` already
returns a single aggregated result object with `requests`, `latency`, `errors`,
`timeouts`, and `non2xx`. The separately exported `aggregateResult()` merges an
**array** of runs; calling it with the single result object throws. The adapter
therefore uses the return value directly.

Targets are restricted to loopback and the caller must authorize network access;
the adapter will not load-test an arbitrary host.

### `octokit` — review

Read-only by construction: the adapter only ever issues hardcoded `GET` routes
(pull request metadata and its file list), so there is no code path that can
write to the repository. It requires an injected token and reports itself
unavailable without one, and it authorizes both `network` and `read-secret`
before use. It is a review *input* provider, not a merge authority.

### `vite`, `fastify`, `drizzle`, `typedoc`

These adapters drive their SDKs for build, server, schema, and documentation
work respectively. Where an SDK has no callable API for a requested step, the
adapter returns a failure result rather than inventing one.

## What is deliberately not claimed

- No adapter claims end-to-end autonomy. Each fills one functional slot.
- No vulnerability feed, model provider, or secret manager is configured here.
- The performance numbers produced by `autocannon` are loopback measurements of
  a local process, not a production capacity claim.
- The registry reports capability **counts**, not a single completion
  percentage, because one number would overstate how far the integrations have
  been taken.

## Evidence

- `v3/__tests__/cortex/cortex-adapters.test.ts` — exercises each adapter against
  the installed package.
- `v3/__tests__/cortex/cortex-registry.test.ts` — descriptor honesty guards and
  one-SDK-per-slot enforcement.
- `v3/__tests__/cortex/cortex-orchestrator.test.ts` — concurrency, deadlines,
  cancellation, dependency ordering, and failure isolation.
- `v3/__tests__/cortex/cortex-swarm.test.ts` — capability-to-role mapping, real
  worktree provisioning, and the rule that only an independent verifier can mark
  a task verified.
