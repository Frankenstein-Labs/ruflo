import { CortexValidationError } from '../errors';
import { assertSafeSegment, safeErrorMessage } from '../security';
import type { CortexCapability } from '../types';
import type {
  OpenHandsSwarm,
  OpenHandsSwarmRole,
  OpenHandsSwarmTask,
  OpenHandsSwarmTaskResult,
  OpenHandsWorkspace,
  OpenHandsWorkspaceProvisioner,
} from '../../openhands/OpenHandsSwarm';
import type { CortexWorkspaceManager } from './workspace';

/**
 * CORTEX capability -> OpenHands swarm role. Both lists have ten entries, and
 * the two that do not share a name are the ones whose CORTEX slot is served by
 * a different kind of agent: planning is done by the architect, and
 * code-execution by the integration agent that runs the whole repository.
 */
export const CAPABILITY_TO_SWARM_ROLE: Readonly<Record<CortexCapability, OpenHandsSwarmRole>> = {
  planning: 'architect',
  'code-execution': 'integration',
  frontend: 'frontend',
  backend: 'backend',
  data: 'data',
  testing: 'testing',
  security: 'security',
  documentation: 'documentation',
  performance: 'performance',
  review: 'review',
};

export interface CortexSwarmTaskRequest {
  readonly taskId: string;
  readonly capability: CortexCapability;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly branchName?: string;
  readonly maxIterations?: number;
}

export interface CortexSwarmOptions {
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
  readonly signal?: AbortSignal;
}

export interface CortexSwarmOutcome {
  readonly taskId: string;
  readonly capability: CortexCapability;
  readonly role: OpenHandsSwarmRole;
  readonly branchName: string;
  readonly status: OpenHandsSwarmTaskResult['status'];
  readonly verified: boolean;
  /** Commit sha on the task branch, set when verified work was persisted. */
  readonly commitSha?: string;
  readonly error?: string;
}

/**
 * Bridges CORTEX's capability model onto the OpenHands multi-agent swarm.
 *
 * The swarm owns branch/worktree isolation and independent verification; this
 * bridge only translates a CORTEX request into a swarm task and reports the
 * outcome. A task is never reported as verified unless the swarm's verifier
 * actually ran and passed.
 */
export class CortexSwarmBridge {
  constructor(
    private readonly swarm: OpenHandsSwarm,
    private readonly workspaces: CortexWorkspaceManager,
  ) {}

  /**
   * Provision an isolated workspace per task, hand each to the swarm, and
   * return an outcome per task. The bridge never marks a task successful on
   * the strength of the agent's own claim.
   */
  async run(
    requests: readonly CortexSwarmTaskRequest[],
    options: CortexSwarmOptions = {},
  ): Promise<CortexSwarmOutcome[]> {
    if (requests.length === 0) return [];
    const ids = new Set<string>();
    for (const request of requests) {
      const taskId = assertSafeSegment(request.taskId, 'taskId', 80);
      if (ids.has(taskId)) {
        throw new CortexValidationError(`taskId ${taskId} appears more than once in the swarm batch.`);
      }
      ids.add(taskId);
      if (!request.instruction.trim()) {
        throw new CortexValidationError(`task ${taskId} requires an instruction.`);
      }
      if (!Array.isArray(request.acceptanceCriteria) || request.acceptanceCriteria.length === 0) {
        throw new CortexValidationError(`task ${taskId} requires at least one acceptance criterion.`);
      }
    }

    const provisioned: Array<{ request: CortexSwarmTaskRequest; record: Awaited<ReturnType<CortexWorkspaceManager['prepare']>> }> = [];
    const outcomes: CortexSwarmOutcome[] = [];
    const tasks: OpenHandsSwarmTask[] = [];

    try {
      for (const request of requests) {
        const role = CAPABILITY_TO_SWARM_ROLE[request.capability];
        if (!role) {
          throw new CortexValidationError(`capability ${request.capability} has no swarm role.`);
        }
        const record = await this.workspaces.prepare(request.taskId, { branchName: request.branchName });
        provisioned.push({ request, record });
        tasks.push({
          taskId: request.taskId,
          role,
          instruction: request.instruction,
          branchName: record.branchName,
          workingDirectory: record.hostPath,
          acceptanceCriteria: [...request.acceptanceCriteria],
          maxIterations: request.maxIterations,
        });
      }

      const results = await this.swarm.run(tasks, {
        concurrency: options.concurrency,
        pollIntervalMs: options.pollIntervalMs,
        maxWaitMs: options.maxWaitMs,
      }, options.signal);

      const byTaskId = new Map(provisioned.map((entry) => [entry.request.taskId, entry.request]));
      for (const result of results) {
        const request = byTaskId.get(result.taskId);
        if (!request) {
          throw new CortexValidationError(`the swarm reported an unknown task ${result.taskId}.`);
        }
        // Only a swarm result that ran its verifier counts as verified.
        const verified = result.status === 'verified' && result.verification?.passed === true;
        // Persist verified work onto its branch before the worktree is removed;
        // otherwise the release below destroys changes the merge coordinator
        // would need.
        let commitSha: string | undefined;
        let commitError: string | undefined;
        if (verified) {
          try {
            const commit = await this.workspaces.commit(result.taskId);
            commitSha = commit.commitSha;
          } catch (error) {
            commitError = safeErrorMessage(error, 200);
          }
        }
        outcomes.push({
          taskId: result.taskId,
          capability: request.capability,
          role: result.role,
          branchName: result.branchName,
          status: result.status,
          verified: verified && commitError === undefined,
          commitSha,
          error: result.error ?? commitError,
        });
      }
      return outcomes;
    } finally {
      // Release every provisioned workspace whether the run succeeded, threw,
      // or was cancelled, so a failed batch never leaks worktrees.
      await this.releaseAll(provisioned);
    }
  }

  private async releaseAll(
    provisioned: Array<{ request: CortexSwarmTaskRequest; record: { taskId: string } }>,
  ): Promise<void> {
    for (const entry of provisioned) {
      try {
        await this.workspaces.release(entry.record.taskId, { deleteBranch: false });
      } catch {
        // Releasing is best effort; a failed release must not mask the run
        // result, and the workspace manager still tracks the record.
      }
    }
  }
}

/**
 * Adapts a CortexWorkspaceManager to the OpenHands swarm's provisioner
 * contract, so both subsystems create exactly one branch + worktree per task
 * through the same guarded code path.
 *
 * The manager owns both paths: `hostPath` is where Git actually writes, and
 * `sandboxPath` is where the Agent Server sees the same directory. This class
 * never derives one from the other, because only the mount configuration knows
 * how they correspond.
 */
export class CortexWorkspaceProvisionerBridge implements OpenHandsWorkspaceProvisioner {
  constructor(private readonly workspaces: CortexWorkspaceManager) {}

  async prepare(task: OpenHandsSwarmTask): Promise<OpenHandsWorkspace> {
    const record = await this.workspaces.prepare(task.taskId, { branchName: task.branchName });
    if (!record.sandboxPath) {
      throw new CortexValidationError(
        'The CORTEX workspace manager must be configured with sandboxRoot before it can provision Agent Server workspaces.',
      );
    }
    return {
      branchName: record.branchName,
      workingDirectory: record.sandboxPath,
      hostWorkingDirectory: record.hostPath,
    };
  }
}

/** Turn a swarm failure into one safe, single-line message for the UI. */
export function describeSwarmOutcome(outcome: CortexSwarmOutcome): string {
  if (outcome.verified) return `${outcome.role} verified ${outcome.taskId} on ${outcome.branchName}.`;
  return `${outcome.role} did not verify ${outcome.taskId}: ${safeErrorMessage(outcome.error ?? outcome.status)}`;
}
