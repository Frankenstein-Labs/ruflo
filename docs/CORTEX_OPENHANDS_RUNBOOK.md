# CORTEX + OpenHands — First Runtime Slice

**Branch:** `cortex-agent-os-audit`  
**Status:** adapter code and mocked tests committed; runtime integration still requires build/test verification and a reachable Agent Server.

## What is implemented

- `OpenHandsAgentBackend` is exported from the V3 public entry point.
- Submits a bounded task to `POST /api/conversations`, then starts it through `POST /api/conversations/{id}/run`.
- Supports retrieving conversation metadata through `GET /api/conversations/{id}`.
- Defaults to disabled, requires HTTPS for remote servers, requires an API key for remote servers, rejects non-absolute and traversal-containing workspace paths, applies request timeouts, supports caller cancellation, and does not expose error response bodies.
- Returns `status: "submitted"`, not `completed`. Task success must not be inferred from submission or a conversation stop state.

## Runtime prerequisites

1. Deploy the official OpenHands Agent Server in a trusted environment. For the current upstream instructions, see the [Agent Server README](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/README.md).
2. Use a dedicated disposable workspace or container per task. The `workingDirectory` path must be visible to the Agent Server; a path on the Ruflo host is not automatically mounted into a remote server.
3. Configure the Agent Server with a supported agent specification/profile and provider credentials through its server-side secret/configuration mechanism. Do not place model-provider keys in this repository, task prompts, logs, or browser clients.
4. Configure authentication on the Agent Server. Remote CORTEX connections require HTTPS and `CORTEX_OPENHANDS_API_KEY`.

## Environment

```bash
CORTEX_OPENHANDS_ENABLED=true
CORTEX_OPENHANDS_BASE_URL=https://your-agent-server.example
CORTEX_OPENHANDS_API_KEY=<secret-from-your-secret-manager>
CORTEX_OPENHANDS_REQUEST_TIMEOUT_MS=60000
```

Keep these values in the deployment secret manager or an untracked local `.env`. Never commit real credentials. Local development may use `http://localhost:8000`; plain HTTP is rejected for non-local hosts.

## Example integration in TypeScript

```ts
import {
  OpenHandsAgentBackend,
  openHandsConfigFromEnv,
} from './openhands/OpenHandsAgentBackend';

// Use a server-supported agent specification. Prefer a server-managed profile
// or secret configuration so provider credentials are not embedded in code.
const agent = {
  // Replace with the exact agent schema supported by your pinned Agent Server.
};

const backend = new OpenHandsAgentBackend(openHandsConfigFromEnv(agent));

const handle = await backend.submit({
  taskId: 'mission-001-task-001',
  instruction: 'Implement the requested change in the authorized repository.',
  workingDirectory: '/workspace/mission-001',
  acceptanceCriteria: [
    'The requested behavior is implemented',
    'Relevant tests pass',
    'No unrelated files are changed',
  ],
});

console.log(handle.conversationId);

// Follow-up step: query backend.getConversation(handle.conversationId),
// collect events/diff using the server's documented APIs, and run the project's
// independent verification pipeline before reporting completion.
```

## Verification status

Mocked tests cover disabled-by-default behavior, HTTPS/API-key requirements, task submission, workspace path traversal, response-body redaction, and environment configuration. These tests have been added but have **not yet been executed in this ChatGPT session**. A live end-to-end run also has not been performed.

## Release gates still open

- Run V3 typecheck/build and the focused test file in CI.
- Pin and record the exact Agent Server release/API contract.
- Add event collection and terminal-state normalization against that pinned release.
- Add an isolated-workspace provisioner; do not let user input choose arbitrary host paths in a public service.
- Add diff collection, test execution, and acceptance-criteria evaluation.
- Add an opt-in integration test with a disposable Agent Server and a non-production model key.
- Open a reviewable pull request and fix any CI failures before merging.
