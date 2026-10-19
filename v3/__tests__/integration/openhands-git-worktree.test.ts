import { describe, expect, it, vi } from 'vitest';
import {
  OpenHandsGitResultVerifier,
} from '../../src/openhands/OpenHandsGitResultVerifier';
import {
  OpenHandsGitWorktreeProvisioner,
} from '../../src/openhands/OpenHandsGitWorktreeProvisioner';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('OpenHandsGitResultVerifier', () => {
  const input = {
    task: {
      taskId: 'agent-1',
      role: 'backend' as const,
      instruction: 'Implement a feature',
      branchName: 'cortex/agent-1',
      workingDirectory: '/host/workspaces/agent-1/worktree',
      acceptanceCriteria: ['Tests pass'],
    },
    workspace: { branchName: 'cortex/agent-1', workingDirectory: '/workspace/agent-1/worktree' },
    conversation: { id: 'conv-1', execution_status: 'finished' },
  };

  it('runs checks in the host worktree and requires actual changes', async () => {
    const runCommand = vi.fn(async (_command: string, args: string[], cwd: string) => ({
      stdout: args.includes('--porcelain') ? ' M README.md' : '',
      stderr: '',
    }));
    const verifier = new OpenHandsGitResultVerifier({
      checks: [{ name: 'unit-tests', command: 'npm', args: ['test', '--', '--run'] }],
      runCommand,
    });

    const result = await verifier.verify(input);
    expect(result.passed).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('git', ['diff', '--check'], input.task.workingDirectory, expect.any(Number));
    expect(runCommand).toHaveBeenCalledWith('git', ['status', '--porcelain', '--untracked-files=all'], input.task.workingDirectory, expect.any(Number));
  });

  it('does not pass a task that produced no changes', async () => {
    const verifier = new OpenHandsGitResultVerifier({
      checks: [{ name: 'unit-tests', command: 'npm', args: ['test'] }],
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });
    const result = await verifier.verify(input);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'git-worktree-has-changes')?.passed).toBe(false);
  });

  it('does not verify an unfinished conversation', async () => {
    const runCommand = vi.fn();
    const verifier = new OpenHandsGitResultVerifier({
      checks: [{ name: 'unit-tests', command: 'npm', args: ['test'] }],
      runCommand: runCommand as never,
    });
    const result = await verifier.verify({
      ...input,
      conversation: { id: 'conv-1', execution_status: 'error' },
    });
    expect(result.passed).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('OpenHandsGitWorktreeProvisioner', () => {
  it('creates a real isolated worktree and maps its path into the Agent Server', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-openhands-'));
    const repositoryRoot = path.join(root, 'repo');
    const hostWorkspaceRoot = path.join(root, 'workspaces');
    await mkdir(repositoryRoot);
    const calls: string[][] = [];
    const runGit = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') {
        await mkdir(args[4], { recursive: true });
        await writeFile(path.join(args[4], '.git'), 'gitdir: mock');
      }
      return { stdout: args[0] === 'branch' ? '' : 'ok', stderr: '' };
    });
    try {
      const provisioner = new OpenHandsGitWorktreeProvisioner({
        repositoryRoot,
        hostWorkspaceRoot,
        serverWorkspaceRoot: '/workspace',
        baseRef: 'main',
        runGit,
      });
      const workspace = await provisioner.prepare({
        taskId: 'agent-1',
        role: 'backend',
        instruction: 'Implement a feature',
        branchName: 'cortex/agent-1',
        workingDirectory: path.join(hostWorkspaceRoot, 'agent-1', 'worktree'),
        acceptanceCriteria: ['Tests pass'],
      });
      expect(workspace).toEqual({
        branchName: 'cortex/agent-1',
        workingDirectory: '/workspace/agent-1/worktree',
      });
      expect(calls).toContainEqual(['worktree', 'add', '-b', 'cortex/agent-1', path.join(hostWorkspaceRoot, 'agent-1', 'worktree'), 'main']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a workspace outside the configured root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-openhands-'));
    const runGit = vi.fn(async () => ({ stdout: '', stderr: '' }));
    try {
      const provisioner = new OpenHandsGitWorktreeProvisioner({
        repositoryRoot: path.join(root, 'repo'),
        hostWorkspaceRoot: path.join(root, 'workspaces'),
        serverWorkspaceRoot: '/workspace',
        runGit,
      });
      await expect(provisioner.prepare({
        taskId: 'agent-1',
        role: 'backend',
        instruction: 'Implement a feature',
        branchName: 'cortex/agent-1',
        workingDirectory: path.join(root, 'outside', 'worktree'),
        acceptanceCriteria: ['Tests pass'],
      })).rejects.toThrow(/child directory/i);
      expect(runGit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
