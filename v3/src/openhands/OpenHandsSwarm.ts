import {
  OpenHandsAgentBackend,
  type OpenHandsConversation,
  type OpenHandsTaskHandle,
} from './OpenHandsAgentBackend';

export const OPENHANDS_SWARM_ROLES = [
  'architect', 'frontend', 'backend', 'data', 'testing',
  'security', 'documentation', 'performance', 'integration', 'review',
] as const;

export type OpenHandsSwarmRole = (typeof OPENHANDS_SWARM_ROLES)[number];

export interface OpenHandsSwarmTask {
  taskId: string;
  role: OpenHandsSwarmRole;
  instruction: string;
  branchName: string;
  workingDirectory: string;
  acceptanceCriteria: string[];
  maxIterations?: number;
}

export interface OpenHandsWorkspace {
  branchName: string;
  /** Absolute path visible inside Agent Server; passed to the OpenHands SDK. */
  workingDirectory: string;
  /** Host path used for Git operations and local verification. */
  hostWorkingDirectory?: string;
}

export interface OpenHandsWorkspaceProvisioner {
  /** Must create a real dedicated Git branch/worktree and isolated workspace. */
  prepare(task: OpenHandsSwarmTask): Promise<OpenHandsWorkspace>;
}

export interface OpenHandsTaskVerification {
  passed: boolean;
  summary: string;
  checks: Array<{ name: string; passed: boolean; details?: string }>;
}

export interface OpenHandsResultVerifier {
  verify(input: {
    task: OpenHandsSwarmTask;
    workspace: OpenHandsWorkspace;
    conversation: OpenHandsConversation;
  }): Promise<OpenHandsTaskVerification>;
}

export type OpenHandsSwarmTaskStatus =
  | 'verified'
  | 'verification-failed'
  | 'execution-failed'
  | 'provisioning-failed';

export interface OpenHandsSwarmTaskResult {
  taskId: string;
  role: OpenHandsSwarmRole;
  branchName: string;
  status: OpenHandsSwarmTaskStatus;
  handle?: OpenHandsTaskHandle;
  conversation?: OpenHandsConversation;
  verification?: OpenHandsTaskVerification;
  error?: string;
}

export interface OpenHandsSwarmOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/**
 * Bounded fan-out over one configured OpenHands Agent Server.
 * These are ten specialist roles, not ten separate vendor SDK products.
 * Branch/workspace provisioning and verification are explicit dependencies.
 */
export class OpenHandsSwarm {
  constructor(
    private readonly backend: OpenHandsAgentBackend,
    private readonly workspaces: OpenHandsWorkspaceProvisioner,
    private readonly verifier: OpenHandsResultVerifier,
  ) {}

  async run(
    tasks: OpenHandsSwarmTask[],
    options: OpenHandsSwarmOptions = {},
    signal?: AbortSignal,
  ): Promise<OpenHandsSwarmTaskResult[]> {
    const concurrency = options.concurrency ?? 10;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      throw new Error('OpenHands swarm concurrency must be an integer from 1 to 10.');
    }
    if (tasks.length < 1 || tasks.length > 10) {
      throw new Error('An OpenHands swarm batch must contain between 1 and 10 tasks.');
    }
    this.validateBatch(tasks);

    const results: OpenHandsSwarmTaskResult[] = new Array(tasks.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return;
        const index = nextIndex++;
        if (index >= tasks.length) return;
        results[index] = await this.runOne(tasks[index], options, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

    for (let i = 0; i < tasks.length; i++) {
      if (!results[i]) {
        results[i] = {
          taskId: tasks[i].taskId,
          role: tasks[i].role,
          branchName: tasks[i].branchName,
          status: 'execution-failed',
          error: 'Task was not started because the swarm was cancelled.',
        };
      }
    }
    return results;
  }

  private validateBatch(tasks: OpenHandsSwarmTask[]): void {
    const ids = new Set<string>();
    const branches = new Set<string>();
    const directories = new Set<string>();
    for (const task of tasks) {
      if (!task.taskId.trim() || ids.has(task.taskId)) {
        throw new Error('Every swarm task must have a non-empty, unique taskId.');
      }
      ids.add(task.taskId);
      if (!task.branchName.trim() || branches.has(task.branchName)) {
        throw new Error('Every swarm task must use a non-empty, unique branchName.');
      }
      branches.add(task.branchName);
      if (!task.workingDirectory.trim() || directories.has(task.workingDirectory)) {
        throw new Error('Every swarm task must use a non-empty, unique workingDirectory.');
      }
      directories.add(task.workingDirectory);
      if (!task.instruction.trim()) throw new Error('Task ' + task.taskId + ' requires an instruction.');
      if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
        throw new Error('Task ' + task.taskId + ' requires acceptance criteria.');
      }
    }
  }

  private async runOne(
    task: OpenHandsSwarmTask,
    options: OpenHandsSwarmOptions,
    signal?: AbortSignal,
  ): Promise<OpenHandsSwarmTaskResult> {
    let workspace: OpenHandsWorkspace;
    try {
      workspace = await this.workspaces.prepare(task);
      if (workspace.branchName !== task.branchName ||
          (!workspace.hostWorkingDirectory && workspace.workingDirectory !== task.workingDirectory)) {
        throw new Error('Provisioner returned a workspace that does not match the requested branch and directory.');
      }
    } catch (error) {
      return {
        taskId: task.taskId,
        role: task.role,
        branchName: task.branchName,
        status: 'provisioning-failed',
        error: this.safeError(error),
      };
    }

    let handle: OpenHandsTaskHandle;
    let conversation: OpenHandsConversation;
    try {
      handle = await this.backend.submit({
        taskId: task.taskId,
        instruction: [
          'You are the CORTEX ' + task.role + ' specialist.',
          'Work only within the assigned workspace and branch.',
          'Do not claim tests passed unless you actually ran them.',
          'Do not modify or access another agent workspace.',
          '',
          task.instruction,
        ].join('\n'),
        workingDirectory: workspace.workingDirectory,
        acceptanceCriteria: task.acceptanceCriteria,
        maxIterations: task.maxIterations,
      }, signal);
      conversation = await this.backend.waitForCompletion(
        handle.conversationId,
        { pollIntervalMs: options.pollIntervalMs, maxWaitMs: options.maxWaitMs },
        signal,
      );
    } catch (error) {
      return {
        taskId: task.taskId,
        role: task.role,
        branchName: task.branchName,
        status: 'execution-failed',
        error: this.safeError(error),
      };
    }

    const executionState = String(conversation.execution_status ?? conversation.status ?? '').toLowerCase();
    if (executionState !== 'finished') {
      return {
        taskId: task.taskId,
        role: task.role,
        branchName: task.branchName,
        status: 'execution-failed',
        handle,
        conversation,
        error: 'OpenHands execution ended in state: ' + (executionState || 'unknown') + '.',
      };
    }

    try {
      const verification = await this.verifier.verify({ task, workspace, conversation });
      return {
        taskId: task.taskId,
        role: task.role,
        branchName: task.branchName,
        status: verification.passed ? 'verified' : 'verification-failed',
        handle,
        conversation,
        verification,
      };
    } catch (error) {
      return {
        taskId: task.taskId,
        role: task.role,
        branchName: task.branchName,
        status: 'verification-failed',
        handle,
        conversation,
        error: this.safeError(error),
      };
    }
  }

  private safeError(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 500);
    return 'Unknown orchestration error.';
  }
}
