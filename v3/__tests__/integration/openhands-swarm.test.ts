import { describe, expect, it, vi } from 'vitest';
import {
  OPENHANDS_SWARM_ROLES,
  OpenHandsSwarm,
  type OpenHandsSwarmTask,
  type OpenHandsWorkspaceProvisioner,
  type OpenHandsResultVerifier,
} from '../../src/openhands/OpenHandsSwarm';

function makeTasks(count = 3): OpenHandsSwarmTask[] {
  return OPENHANDS_SWARM_ROLES.slice(0, count).map((role, index) => ({
    taskId: 'task-' + index,
    role,
    instruction: 'Implement isolated slice ' + index,
    branchName: 'cortex/task-' + index,
    workingDirectory: '/workspace/task-' + index,
    acceptanceCriteria: ['Relevant checks pass'],
  }));
}

function makeHarness() {
  const backend = {
    submit: vi.fn(async (task: { taskId: string }) => ({
      provider: 'openhands' as const,
      taskId: task.taskId,
      conversationId: 'conversation-' + task.taskId,
      status: 'submitted' as const,
      serverUrl: 'http://localhost:8000',
    })),
    waitForCompletion: vi.fn(async (id: string) => ({
      id,
      execution_status: 'finished',
    })),
  };
  const workspaces: OpenHandsWorkspaceProvisioner = {
    prepare: vi.fn(async (task) => ({
      branchName: task.branchName,
      workingDirectory: task.workingDirectory,
    })),
  };
  const verifier: OpenHandsResultVerifier = {
    verify: vi.fn(async () => ({
      passed: true,
      summary: 'Checks passed',
      checks: [{ name: 'acceptance', passed: true }],
    })),
  };
  return { backend, workspaces, verifier };
}

describe('OpenHandsSwarm', () => {
  it('defines ten specialized roles', () => {
    expect(OPENHANDS_SWARM_ROLES).toHaveLength(10);
  });

  it('runs tasks and verifies results before reporting verified', async () => {
    const harness = makeHarness();
    const swarm = new OpenHandsSwarm(harness.backend as never, harness.workspaces, harness.verifier);
    const results = await swarm.run(makeTasks(3), { concurrency: 2 });
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === 'verified')).toBe(true);
    expect(harness.backend.submit).toHaveBeenCalledTimes(3);
    expect(harness.verifier.verify).toHaveBeenCalledTimes(3);
  });

  it('rejects duplicate branches and directories before starting work', async () => {
    const harness = makeHarness();
    const swarm = new OpenHandsSwarm(harness.backend as never, harness.workspaces, harness.verifier);
    const tasks = makeTasks(2);
    tasks[1].branchName = tasks[0].branchName;
    await expect(swarm.run(tasks)).rejects.toThrow('unique branchName');
    expect(harness.backend.submit).not.toHaveBeenCalled();
  });

  it('never marks failed verification as verified', async () => {
    const harness = makeHarness();
    harness.verifier.verify = vi.fn(async () => ({
      passed: false,
      summary: 'Tests failed',
      checks: [{ name: 'tests', passed: false, details: 'one test failed' }],
    }));
    const swarm = new OpenHandsSwarm(harness.backend as never, harness.workspaces, harness.verifier);
    const results = await swarm.run(makeTasks(1));
    expect(results[0].status).toBe('verification-failed');
  });

  it('rejects concurrency above ten', async () => {
    const harness = makeHarness();
    const swarm = new OpenHandsSwarm(harness.backend as never, harness.workspaces, harness.verifier);
    await expect(swarm.run(makeTasks(1), { concurrency: 11 })).rejects.toThrow('from 1 to 10');
  });
});
