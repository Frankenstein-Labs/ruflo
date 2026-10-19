import { OpenHandsAgentBackend, OpenHandsBackendError } from '../../openhands/OpenHandsAgentBackend';
import { CortexSdkUnavailableError } from '../errors';
import { assertLive, authorize, redactText, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import { buildResult, failureResult, taskWorkspaceRoot } from './shared';

export interface OpenHandsAdapterOptions {
  /** Official Agent Server base URL; HTTPS required for non-local hosts. */
  baseUrl?: string;
  apiKey?: string;
  /** Must be true; the adapter never enables a remote runtime implicitly. */
  enabled?: boolean;
  agent?: { kind: string; llm: { model: string; [key: string]: unknown }; [key: string]: unknown };
  /** Absolute path the Agent Server is allowed to see. */
  allowedWorkspaceRoot?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  /** Injectable transport for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export const OPENHANDS_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'openhands',
  capability: 'code-execution',
  name: 'OpenHands Software Agent SDK / Agent Server',
  packageName: 'openhands-sdk',
  version: '1.56.0',
  license: 'MIT',
  source: 'https://github.com/OpenHands/software-agent-sdk',
  registry: 'pypi',
  dependencyType: 'external-service',
  capabilities: [
    'run a coding agent against an isolated workspace',
    'submit a bounded task and poll execution state',
    'recover a conversation id when start fails after creation',
  ],
  status: 'mock-tested',
  limitations: [
    'Requires a running Agent Server; the adapter talks REST, it does not embed the Python SDK.',
    'No live Agent Server was started in this repository, so no task has been executed end to end.',
    'Conversation completion is not proof of correctness: CORTEX verification is still required.',
  ],
};

/**
 * CORTEX code-execution SDK. Wraps the pinned official OpenHands Agent Server
 * REST contract; it never re-implements the agent runtime.
 */
export class OpenHandsAdapter implements CortexSdkAdapter {
  readonly descriptor = OPENHANDS_DESCRIPTOR;
  private readonly options: OpenHandsAdapterOptions;

  constructor(options: OpenHandsAdapterOptions = {}) {
    const env = options.env ?? process.env;
    this.options = {
      ...options,
      baseUrl: options.baseUrl ?? env.CORTEX_OPENHANDS_BASE_URL,
      apiKey: options.apiKey ?? env.CORTEX_OPENHANDS_API_KEY,
      enabled: options.enabled ?? env.CORTEX_OPENHANDS_ENABLED === 'true',
      allowedWorkspaceRoot: options.allowedWorkspaceRoot ?? env.CORTEX_OPENHANDS_ALLOWED_WORKSPACE_ROOT,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.options.enabled !== true) return false;
    if (!this.options.baseUrl || !this.options.agent || !this.options.allowedWorkspaceRoot) return false;
    try {
      this.buildBackend();
      return true;
    } catch {
      return false;
    }
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'openhands task');
    let backend: OpenHandsAgentBackend;
    try {
      backend = this.buildBackend();
    } catch (error) {
      throw new CortexSdkUnavailableError(this.descriptor.id, safeErrorMessage(error, 200));
    }

    const hostRoot = taskWorkspaceRoot(task);
    const sandboxRoot = task.workspace.sandboxRoot ?? this.options.allowedWorkspaceRoot;
    if (!sandboxRoot) {
      throw new CortexSdkUnavailableError(
        this.descriptor.id,
        'no sandbox workspace root configured for the Agent Server.',
      );
    }

    authorize(ctx, this.descriptor.id, 'network', `submit task to ${backend.constructor.name}`);
    authorize(ctx, this.descriptor.id, 'write-workspace', `agent edits inside ${sandboxRoot}`);

    const handle = await backend.submit(
      {
        taskId: task.taskId,
        instruction: this.composeInstruction(task),
        workingDirectory: sandboxRoot,
        acceptanceCriteria: [...task.acceptanceCriteria],
        maxIterations: readMaxIterations(task),
      },
      ctx.signal,
    );

    ctx.log({
      level: 'info',
      sdkId: this.descriptor.id,
      message: 'conversation submitted',
      data: { conversationId: handle.conversationId, hostRoot },
    });

    const conversation = await backend.waitForCompletion(
      handle.conversationId,
      { pollIntervalMs: this.options.pollIntervalMs, maxWaitMs: this.options.maxWaitMs },
      ctx.signal,
    );

    const state = String(conversation.execution_status ?? conversation.status ?? 'unknown').toLowerCase();
    const evidence = {
      conversationId: handle.conversationId,
      executionStatus: state,
      server: handle.serverUrl,
      // Deliberately excluded: prompts, transcripts, tool output and provider
      // diagnostics, which can contain secrets or untrusted repository content.
    };

    if (state !== 'finished') {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        evidence,
        error: `OpenHands ended in state "${state}" (not finished); CORTEX did not accept the result.`,
      });
    }

    return buildResult({
      task,
      sdkId: this.descriptor.id,
      status: 'succeeded',
      startedAt,
      artifacts: [{ name: 'agent-conversation', kind: 'log', summary: `conversation ${handle.conversationId} finished` }],
      evidence,
    });
  }

  private composeInstruction(task: CortexSdkTask): string {
    return [
      'You are the CORTEX code-execution agent.',
      'Work only inside the assigned workspace and branch. Do not touch other workspaces.',
      'Do not claim a test passed unless you actually ran it.',
      'Report failures honestly; a partial result is better than a false success.',
      '',
      redactText(task.instruction, 20_000),
      '',
      'Acceptance criteria (CORTEX verifies these independently):',
      ...task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    ].join('\n');
  }

  private buildBackend(): OpenHandsAgentBackend {
    if (this.options.enabled !== true) {
      throw new OpenHandsBackendError('OpenHands backend is disabled (set CORTEX_OPENHANDS_ENABLED=true).');
    }
    if (!this.options.baseUrl) throw new OpenHandsBackendError('CORTEX_OPENHANDS_BASE_URL is not configured.');
    if (!this.options.agent) throw new OpenHandsBackendError('an OpenHands agent specification is required.');
    if (!this.options.allowedWorkspaceRoot) {
      throw new OpenHandsBackendError('CORTEX_OPENHANDS_ALLOWED_WORKSPACE_ROOT is not configured.');
    }
    return new OpenHandsAgentBackend({
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      enabled: true,
      agent: this.options.agent,
      allowedWorkspaceRoot: this.options.allowedWorkspaceRoot,
      timeoutMs: this.options.requestTimeoutMs,
      fetchImpl: this.options.fetchImpl,
    });
  }
}

function readMaxIterations(task: CortexSdkTask): number | undefined {
  const value = task.options?.maxIterations;
  return typeof value === 'number' ? value : undefined;
}
