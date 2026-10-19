/**
 * Live end-to-end check: drive the REAL CORTEX swarm stack against a REAL
 * OpenHands Agent Server. Not a unit test — it is run explicitly and is skipped
 * unless CORTEX_LIVE_AGENT_SERVER_URL is set.
 *
 * Proves three things at once:
 *  1. the TypeScript adapter contract works against the real server;
 *  2. several independent tasks run concurrently;
 *  3. each task's change lands only in its own Git worktree.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { OpenHandsAgentBackend } from '../../src/openhands/OpenHandsAgentBackend';
import { OpenHandsSwarm } from '../../src/openhands/OpenHandsSwarm';
import { CortexWorkspaceManager } from '../../src/cortex/runtime/workspace';
import { CortexMergeCoordinator } from '../../src/cortex/runtime/merge';
import {
  CortexSwarmBridge,
  CortexWorkspaceProvisionerBridge,
} from '../../src/cortex/runtime/swarm';

const execFileAsync = promisify(execFile);
const LIVE_URL = process.env.CORTEX_LIVE_AGENT_SERVER_URL;
const LIVE_KEY = process.env.CORTEX_LIVE_SESSION_API_KEY ?? '';
const LIVE_LLM_KEY = process.env.CORTEX_LIVE_LLM_API_KEY ?? '';
/** Host directory bind-mounted into the container (host side of the mount). */
const MOUNT_HOST_ROOT = process.env.CORTEX_LIVE_MOUNT_HOST_ROOT ?? '/tmp/oh-workspaces';
/** Path the same directory has inside the container (container side). */
const SANDBOX_ROOT = process.env.CORTEX_LIVE_SANDBOX_ROOT ?? '/workspace';

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

describe.skipIf(!LIVE_URL)('CORTEX live swarm against a real Agent Server', () => {
  it('runs independent tasks concurrently without mixing their changes', async () => {
    // The host root must live inside the directory bind-mounted into the
    // container, and the manager derives sandboxPath as
    // sandboxRoot/<taskId>/worktree, so the Git repo itself is the host root.
    const repo = await mkdtemp(path.join(MOUNT_HOST_ROOT, 'cortex-live-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    await git(['config', 'user.email', 'cortex@test.local'], repo);
    await git(['config', 'user.name', 'CORTEX Live'], repo);
    await writeFile(path.join(repo, 'base.txt'), 'base\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-qm', 'init'], repo);

    // hostRoot is bind-mounted into the container at SANDBOX_ROOT, so map the
    // concrete host repo path onto its container path rather than assuming the
    // two roots are identical.
    const sandboxRoot = repo.replace(MOUNT_HOST_ROOT, SANDBOX_ROOT);

    const workspaces = new CortexWorkspaceManager({
      hostRoot: repo,
      sandboxRoot,
      baseRef: 'main',
      repositoryRoot: repo,
      maxConcurrent: 4,
    });

    const backend = new OpenHandsAgentBackend({
      baseUrl: LIVE_URL!,
      apiKey: LIVE_KEY,
      enabled: true,
      agent: {
        kind: 'CodeActAgent',
        llm: {
          model: process.env.CORTEX_LIVE_MODEL ?? 'openai/deepseek-v4-flash',
          // The LLM object is forwarded to Agent Server verbatim, so it uses the
          // SDK's snake_case field name, not the backend's camelCase apiKey.
          api_key: LIVE_LLM_KEY,
          base_url: process.env.CORTEX_LIVE_LLM_BASE_URL ?? 'https://llm-proxy.app.all-hands.dev',
        },
      },
      allowedWorkspaceRoot: sandboxRoot,
      timeoutMs: 120_000,
    });

    // Record the real host worktree per task so isolation can be asserted.
    const hostByTask = new Map<string, string>();
    const provisioner = {
      prepare: async (task: { taskId: string; branchName: string; workingDirectory: string }) => {
        const prepared = await new CortexWorkspaceProvisionerBridge(workspaces).prepare(task as never);
        hostByTask.set(task.taskId, prepared.hostWorkingDirectory!);
        return prepared;
      },
    };
    // Isolation is checked inside the verifier: the bridge removes every
    // worktree in its finally block, so it cannot be inspected afterwards.
    const contamination: string[] = [];
    const swarm = new OpenHandsSwarm(backend, provisioner, {
      verify: async ({ task, workspace }) => {
        const host = workspace.hostWorkingDirectory!;
        const target = path.join(host, `${task.taskId}.txt`);
        const passed = existsSync(target) && (await readFile(target, 'utf8')).trim() === task.taskId;
        for (const other of ['alpha', 'beta', 'gamma'].filter((n) => n !== task.taskId)) {
          if (existsSync(path.join(host, `${other}.txt`))) {
            contamination.push(`${other}.txt found in ${task.taskId}`);
          }
        }
        return {
          passed,
          summary: passed ? `${task.taskId}.txt present` : `${task.taskId}.txt missing or wrong`,
          checks: [{ name: 'marker-file', passed }],
        };
      },
    });

    const bridge = new CortexSwarmBridge(swarm, workspaces);
    // Distinct capabilities map to distinct specialist roles, so this exercises
    // three different roles running at once rather than three copies of one.
    const plan: Array<{ name: string; capability: 'testing' | 'documentation' | 'security' }> = [
      { name: 'alpha', capability: 'testing' },
      { name: 'beta', capability: 'documentation' },
      { name: 'gamma', capability: 'security' },
    ];
    const requests = plan.map(({ name, capability }) => ({
      taskId: name,
      capability,
      instruction:
        `Create a file named ${name}.txt in your working directory containing exactly ` +
        `the single word ${name}. Do not create any other file.`,
      acceptanceCriteria: [`${name}.txt exists and contains ${name}`],
    }));

    const outcomes = await bridge.run(requests, {
      concurrency: 3,
      pollIntervalMs: 3_000,
      maxWaitMs: 300_000,
    });

    // Every task must reach the verifier, and the verifier must pass.
    for (const outcome of outcomes) {
      expect(outcome.status, `${outcome.taskId}: ${outcome.error ?? ''}`).toBe('verified');
      expect(outcome.verified).toBe(true);
    }
    // Three distinct roles really ran.
    expect(new Set(outcomes.map((o) => o.role))).toEqual(new Set(['testing', 'documentation', 'security']));
    // Verified work was committed onto each task branch before the worktree was
    // removed, so the branch is not still sitting on the base commit.
    const baseSha = (await git(['rev-parse', 'main'], repo)).trim();
    for (const outcome of outcomes) {
      expect(outcome.commitSha, `${outcome.taskId} commit`).toBeTruthy();
      expect(outcome.commitSha).not.toBe(baseSha);
    }

    // Isolation: no task's marker file appeared in another task's workspace.
    expect(contamination, contamination.join('; ')).toEqual([]);
    // Each task really did get its own worktree path.
    expect(new Set(hostByTask.values()).size).toBe(3);

    // Finally, integrate only the verified branches and check the result.
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });
    const report = await coordinator.integrate(
      outcomes.map((outcome) => ({
        taskId: outcome.taskId,
        branchName: outcome.branchName,
        verified: outcome.verified,
      })),
    );

    expect(report.complete, JSON.stringify(report.results)).toBe(true);
    expect(report.results.every((r) => r.status === 'merged')).toBe(true);

    // The integration branch contains all three agent files.
    const tracked = await git(['ls-tree', '-r', '--name-only', report.integrationBranch], repo);
    for (const { name } of plan) expect(tracked).toContain(`${name}.txt`);
  }, 900_000);
});
