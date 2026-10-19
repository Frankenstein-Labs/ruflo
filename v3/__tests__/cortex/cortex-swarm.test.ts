import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CortexValidationError } from '../../src/cortex';
import {
  CAPABILITY_TO_SWARM_ROLE,
  CortexSwarmBridge,
  CortexWorkspaceProvisionerBridge,
  describeSwarmOutcome,
} from '../../src/cortex/runtime/swarm';
import { CortexWorkspaceManager } from '../../src/cortex/runtime/workspace';
import {
  OPENHANDS_SWARM_ROLES,
  OpenHandsSwarm,
  type OpenHandsResultVerifier,
  type OpenHandsSwarmTask,
  type OpenHandsSwarmTaskResult,
} from '../../src/openhands/OpenHandsSwarm';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Create a real Git repository with one commit and a host workspace root. */
async function realRepository(): Promise<{ repositoryRoot: string; hostRoot: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-swarm-'));
  tempRoots.push(base);
  const repositoryRoot = path.join(base, 'repo');
  const hostRoot = path.join(base, 'workspaces');
  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.mkdir(hostRoot, { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot });
  await execFileAsync('git', ['config', 'user.email', 'cortex@example.com'], { cwd: repositoryRoot });
  await execFileAsync('git', ['config', 'user.name', 'CORTEX'], { cwd: repositoryRoot });
  await fs.writeFile(path.join(repositoryRoot, 'README.md'), '# cortex\n');
  await execFileAsync('git', ['add', '.'], { cwd: repositoryRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repositoryRoot });
  return { repositoryRoot, hostRoot };
}

function gitRunner() {
  return async (args: string[], cwd: string) => {
    try {
      const result = await execFileAsync('git', args, { cwd });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      };
    }
  };
}

function manager(hostRoot: string, repositoryRoot: string): CortexWorkspaceManager {
  return new CortexWorkspaceManager({
    hostRoot,
    repositoryRoot,
    baseRef: 'main',
    runGit: gitRunner(),
  });
}

function passingVerifier(): OpenHandsResultVerifier {
  return {
    verify: vi.fn(async () => ({
      passed: true,
      summary: 'checks passed',
      checks: [{ name: 'unit', passed: true }],
    })),
  };
}

function swarmWith(verifier: OpenHandsResultVerifier, state = 'finished'): OpenHandsSwarm {
  const backend = {
    submit: vi.fn(async (task: OpenHandsSwarmTask) => ({
      provider: 'openhands' as const,
      taskId: task.taskId,
      conversationId: `conv-${task.taskId}`,
      status: 'submitted' as const,
      serverUrl: 'http://localhost:8000',
    })),
    waitForCompletion: vi.fn(async (id: string) => ({
      id,
      execution_status: state,
    })),
  };
  return new OpenHandsSwarm(
    backend as unknown as ConstructorParameters<typeof OpenHandsSwarm>[0],
    { prepare: async (task) => ({ branchName: task.branchName, workingDirectory: task.workingDirectory }) },
    verifier,
  );
}

describe('CORTEX capability to swarm role mapping', () => {
  it('maps every capability onto a real swarm role', () => {
    const roles = Object.values(CAPABILITY_TO_SWARM_ROLE);
    expect(roles).toHaveLength(10);
    for (const role of roles) expect(OPENHANDS_SWARM_ROLES).toContain(role);
    expect(new Set(roles).size).toBe(10);
  });
});

describe('CortexWorkspaceProvisionerBridge', () => {
  it('translates a host worktree into a sandbox path without confusing the two', async () => {
    const { repositoryRoot, hostRoot } = await realRepository();
    const workspaces = new CortexWorkspaceManager({
      hostRoot,
      repositoryRoot,
      baseRef: 'main',
      sandboxRoot: '/agent-workspace',
      runGit: gitRunner(),
    });
    const bridge = new CortexWorkspaceProvisionerBridge(workspaces);

    const workspace = await bridge.prepare({
      taskId: 'task-a',
      role: 'architect',
      instruction: 'x',
      branchName: 'cortex/task-a',
      workingDirectory: path.join(hostRoot, 'task-a'),
      acceptanceCriteria: ['y'],
    });

    expect(workspace.branchName).toBe('cortex/task-a');
    // The Agent Server path is a mount point, not a transformed host path.
    expect(workspace.workingDirectory).toBe('/agent-workspace/task-a/worktree');
    expect(workspace.hostWorkingDirectory).not.toBe(workspace.workingDirectory);
    await expect(fs.access(path.join(workspace.hostWorkingDirectory!, 'README.md'))).resolves.toBeUndefined();
  }, 60_000);

  it('refuses to provision an Agent Server workspace without a sandbox root', async () => {
    const { repositoryRoot, hostRoot } = await realRepository();
    const bridge = new CortexWorkspaceProvisionerBridge(manager(hostRoot, repositoryRoot));
    await expect(bridge.prepare({
      taskId: 'task-a',
      role: 'architect',
      instruction: 'x',
      branchName: 'cortex/task-a',
      workingDirectory: path.join(hostRoot, 'task-a'),
      acceptanceCriteria: ['y'],
    })).rejects.toThrow(/sandboxRoot/);
  }, 60_000);
});

describe('CortexSwarmBridge', () => {
  async function bridgeFixture(state = 'finished') {
    const { repositoryRoot, hostRoot } = await realRepository();
    const workspaces = manager(hostRoot, repositoryRoot);
    const verifier = passingVerifier();
    return {
      workspaces,
      verifier,
      bridge: new CortexSwarmBridge(swarmWith(verifier, state), workspaces),
      hostRoot,
    };
  }

  it('provisions one real worktree per capability and reports verified outcomes', async () => {
    const { bridge, hostRoot } = await bridgeFixture();
    const outcomes = await bridge.run([
      { taskId: 'plan', capability: 'planning', instruction: 'Plan it', acceptanceCriteria: ['plan exists'] },
      { taskId: 'test', capability: 'testing', instruction: 'Test it', acceptanceCriteria: ['suite green'] },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => outcome.role).sort()).toEqual(['architect', 'testing']);
    expect(outcomes.every((outcome) => outcome.verified)).toBe(true);

    // Two distinct branches were really created, then released.
    const branches = await execFileAsync('git', ['branch', '--list'], { cwd: path.join(hostRoot, '..', 'repo') });
    expect(branches.stdout).toMatch(/cortex\/plan/);
    expect(branches.stdout).toMatch(/cortex\/test/);
  }, 60_000);

  it('never reports verified when the verifier failed', async () => {
    const { repositoryRoot, hostRoot } = await realRepository();
    const workspaces = manager(hostRoot, repositoryRoot);
    const failingVerifier: OpenHandsResultVerifier = {
      verify: async () => ({ passed: false, summary: 'tests failed', checks: [{ name: 'unit', passed: false }] }),
    };
    const bridge = new CortexSwarmBridge(swarmWith(failingVerifier), workspaces);

    const outcomes = await bridge.run([
      { taskId: 'test', capability: 'testing', instruction: 'Test it', acceptanceCriteria: ['suite green'] },
    ]);
    expect(outcomes[0].verified).toBe(false);
    expect(outcomes[0].status).toBe('verification-failed');
  }, 60_000);

  it('never reports verified when the agent execution did not finish', async () => {
    const { bridge } = await bridgeFixture('error');
    const outcomes = await bridge.run([
      { taskId: 'test', capability: 'testing', instruction: 'Test it', acceptanceCriteria: ['suite green'] },
    ]);
    expect(outcomes[0].verified).toBe(false);
    expect(outcomes[0].status).toBe('execution-failed');
  }, 60_000);

  it('rejects a duplicate taskId before provisioning anything', async () => {
    const { bridge, hostRoot } = await bridgeFixture();
    await expect(bridge.run([
      { taskId: 'dup', capability: 'testing', instruction: 'a', acceptanceCriteria: ['x'] },
      { taskId: 'dup', capability: 'security', instruction: 'b', acceptanceCriteria: ['y'] },
    ])).rejects.toThrow(/more than once/);
    const entries = await fs.readdir(hostRoot);
    expect(entries).toHaveLength(0);
  }, 60_000);

  it('releases every provisioned workspace after a successful batch', async () => {
    const { bridge, workspaces } = await bridgeFixture();
    await bridge.run([
      { taskId: 'one', capability: 'testing', instruction: 'a', acceptanceCriteria: ['x'] },
      { taskId: 'two', capability: 'security', instruction: 'b', acceptanceCriteria: ['y'] },
    ]);
    expect(workspaces.active()).toHaveLength(0);
  }, 60_000);

  it('releases provisioned workspaces even when the swarm itself throws', async () => {
    const { repositoryRoot, hostRoot } = await realRepository();
    const workspaces = manager(hostRoot, repositoryRoot);
    const explodingSwarm = {
      run: async () => { throw new Error('swarm transport down'); },
    } as unknown as OpenHandsSwarm;
    const bridge = new CortexSwarmBridge(explodingSwarm, workspaces);

    await expect(bridge.run([
      { taskId: 'one', capability: 'testing', instruction: 'a', acceptanceCriteria: ['x'] },
    ])).rejects.toThrow(/swarm transport down/);

    expect(workspaces.active()).toHaveLength(0);
  }, 60_000);

  it('summarises an unverified outcome without leaking detail', () => {
    const line = describeSwarmOutcome({
      taskId: 't1',
      capability: 'testing',
      role: 'testing',
      branchName: 'cortex/t1',
      status: 'verification-failed',
      verified: false,
      error: 'tests failed\nsecond line',
    });
    expect(line).not.toContain('\n');
    expect(line).toMatch(/did not verify t1/);
  });
});

describe('swarm result honesty', () => {
  it('does not treat a submitted task as verified', async () => {
    const verifier = passingVerifier();
    const swarm = swarmWith(verifier, 'running');
    const results: OpenHandsSwarmTaskResult[] = await swarm.run([{
      taskId: 't1',
      role: 'testing',
      instruction: 'x',
      branchName: 'cortex/t1',
      workingDirectory: '/tmp/t1',
      acceptanceCriteria: ['y'],
    }]);
    expect(results[0].status).toBe('execution-failed');
    expect(verifier.verify).not.toHaveBeenCalled();
  }, 60_000);
});
