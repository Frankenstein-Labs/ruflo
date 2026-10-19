# CORTEX + official OpenHands Agent Server

This directory runs the upstream OpenHands Agent Server; it does not reimplement the agent runtime. The official SDK source is linked at `vendor/openhands-software-agent-sdk` as a Git submodule and pinned to the commit recorded in the parent repository tree.

## 1. Fetch the real upstream source

From the Ruflo repository root:

```bash
git submodule update --init --recursive vendor/openhands-software-agent-sdk
```

The submodule points to https://github.com/OpenHands/software-agent-sdk. It contains the Python SDK, tools, workspace implementations, Agent Server, REST/WebSocket API, and TypeScript client. Ruflo keeps one pinned upstream source tree; the ten CORTEX workers are isolated executions, not ten divergent copies of the SDK.

## 2. Start the Agent Server

Use Docker Compose v2 from this directory. Set the model provider credentials in the shell or a local `.env` file that is never committed:

```bash
export LLM_API_KEY='your-provider-key'
export LLM_MODEL='your-provider/model-name'
docker compose up -d
```

Check status with `docker compose ps` and logs with `docker compose logs -f agent-server`. The compose file binds port 8000 to loopback only. Do not expose this port directly to the public internet. For remote deployment, use HTTPS, authentication, network restrictions, and a secret manager.

## 3. Connect Ruflo

Configure the existing `OpenHandsAgentBackend` with:

- `CORTEX_OPENHANDS_ENABLED=true`
- `CORTEX_OPENHANDS_BASE_URL=http://localhost:8000` for local development only
- `CORTEX_OPENHANDS_ALLOWED_WORKSPACE_ROOT=/workspace`
- `CORTEX_OPENHANDS_API_KEY` only when using an authenticated remote gateway

Every task's `workingDirectory` must be a real path inside `/workspace` as seen by the Agent Server. The current swarm interface intentionally requires an injected workspace provisioner and verifier. Until those production implementations are supplied and tested, the swarm must not claim that a task has passed or merge its branch.

## 4. Safety and verification

- Never put provider keys in source control or browser code.
- Start with one disposable test workspace and one low-risk task.
- Keep each worker in its own Git worktree/branch and workspace directory.
- Run tests and inspect the diff outside the agent before accepting output.
- Increase concurrency gradually; ten workers can multiply token, CPU, and memory costs.
- The compose healthcheck and image tag must be verified against the selected deployment environment before production use.

## Upstream

- Source: https://github.com/OpenHands/software-agent-sdk
- Docs: https://docs.openhands.dev/sdk
- Upstream revision: `33d8aa29c3078d074799e2fbf5e847aeb2d71360`
- Upstream license: MIT (retain upstream notices when redistributing).
