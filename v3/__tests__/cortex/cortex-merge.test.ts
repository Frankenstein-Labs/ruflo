import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CortexMergeCoordinator, CortexValidationError } from '../../src/cortex';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/**
 * Real repository with a `main` branch and one branch per candidate. Each
 * candidate writes its own file, so isolation is visible in the merged tree.
 */
async function repositoryWithBranches(
  branches: Record<string, Record<string, string>>,
): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-merge-'));
  tempRoots.push(repo);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.email', 'cortex@example.com'], repo);
  await git(['config', 'user.name', 'CORTEX'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), '# cortex\n');
  await git(['add', '.'], repo);
  await git(['commit', '-qm', 'init'], repo);

  for (const [branch, files] of Object.entries(branches)) {
    await git(['checkout', '-q', '-b', branch, 'main'], repo);
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(repo, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    await git(['add', '.'], repo);
    await git(['commit', '-qm', `work on ${branch}`], repo);
  }
  await git(['checkout', '-q', 'main'], repo);
  return repo;
}

describe('CortexMergeCoordinator', () => {
  it('merges verified branches and leaves the integration branch with every change', async () => {
    const repo = await repositoryWithBranches({
      'cortex/alpha': { 'alpha.txt': 'alpha\n' },
      'cortex/beta': { 'beta.txt': 'beta\n' },
    });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    const report = await coordinator.integrate([
      { taskId: 'alpha', branchName: 'cortex/alpha', verified: true },
      { taskId: 'beta', branchName: 'cortex/beta', verified: true },
    ]);

    expect(report.complete).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual(['merged', 'merged']);
    expect(report.integrationBranch).toBe('cortex/integration');

    const tracked = await git(['ls-tree', '-r', '--name-only', 'cortex/integration'], repo);
    expect(tracked).toContain('alpha.txt');
    expect(tracked).toContain('beta.txt');
  });

  it('refuses to integrate an unverified candidate', async () => {
    const repo = await repositoryWithBranches({
      'cortex/alpha': { 'alpha.txt': 'alpha\n' },
      'cortex/beta': { 'beta.txt': 'beta\n' },
    });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    const report = await coordinator.integrate([
      { taskId: 'alpha', branchName: 'cortex/alpha', verified: true },
      { taskId: 'beta', branchName: 'cortex/beta', verified: false },
    ]);

    expect(report.complete).toBe(false);
    expect(report.results.find((r) => r.taskId === 'beta')?.status).toBe('skipped-unverified');

    // The unverified branch's file must not be in the integration branch.
    const tracked = await git(['ls-tree', '-r', '--name-only', 'cortex/integration'], repo);
    expect(tracked).toContain('alpha.txt');
    expect(tracked).not.toContain('beta.txt');
  });

  it('reports a conflict and leaves the integration branch on the last good merge', async () => {
    const repo = await repositoryWithBranches({
      'cortex/alpha': { 'shared.txt': 'from alpha\n' },
      'cortex/beta': { 'shared.txt': 'from beta\n' },
    });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    const report = await coordinator.integrate([
      { taskId: 'alpha', branchName: 'cortex/alpha', verified: true },
      { taskId: 'beta', branchName: 'cortex/beta', verified: true },
    ]);

    expect(report.complete).toBe(false);
    const conflict = report.results.find((r) => r.taskId === 'beta');
    expect(conflict?.status).toBe('conflict');
    expect(conflict?.conflictedFiles).toContain('shared.txt');

    // No merge in progress, and the last good merge survived.
    const status = await git(['status', '--porcelain'], repo);
    expect(status.trim()).toBe('');
    const shared = await git(['show', 'cortex/integration:shared.txt'], repo);
    expect(shared.trim()).toBe('from alpha');
  });

  it('integrates dependencies before their dependents', async () => {
    const repo = await repositoryWithBranches({
      'cortex/base': { 'base.txt': 'base\n' },
      'cortex/feature': { 'feature.txt': 'feature\n' },
    });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    // Listed feature-first on purpose; the coordinator must reorder.
    const report = await coordinator.integrate([
      { taskId: 'feature', branchName: 'cortex/feature', verified: true, dependsOn: ['base'] },
      { taskId: 'base', branchName: 'cortex/base', verified: true },
    ]);

    expect(report.results.map((r) => r.taskId)).toEqual(['base', 'feature']);
    expect(report.complete).toBe(true);
  });

  it('rejects a dependency cycle instead of guessing an order', async () => {
    const repo = await repositoryWithBranches({
      'cortex/a': { 'a.txt': 'a\n' },
      'cortex/b': { 'b.txt': 'b\n' },
    });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    await expect(coordinator.integrate([
      { taskId: 'a', branchName: 'cortex/a', verified: true, dependsOn: ['b'] },
      { taskId: 'b', branchName: 'cortex/b', verified: true, dependsOn: ['a'] },
    ])).rejects.toThrow(/cycle/i);
  });

  it('rejects a dependency that is not part of the batch', async () => {
    const repo = await repositoryWithBranches({ 'cortex/a': { 'a.txt': 'a\n' } });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    await expect(coordinator.integrate([
      { taskId: 'a', branchName: 'cortex/a', verified: true, dependsOn: ['ghost'] },
    ])).rejects.toThrow(CortexValidationError);
  });

  it('is idempotent: a second run does not stack on the first', async () => {
    const repo = await repositoryWithBranches({ 'cortex/alpha': { 'alpha.txt': 'alpha\n' } });
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    await coordinator.integrate([{ taskId: 'alpha', branchName: 'cortex/alpha', verified: true }]);
    const first = await git(['rev-parse', 'cortex/integration'], repo);
    const second = await coordinator.integrate([
      { taskId: 'alpha', branchName: 'cortex/alpha', verified: true },
    ]);
    const after = await git(['rev-parse', 'cortex/integration'], repo);

    expect(second.complete).toBe(true);
    expect(after.trim()).toBe(first.trim());
  });

  it('rejects an unsafe branch name before touching Git', async () => {
    const repo = await repositoryWithBranches({});
    const coordinator = new CortexMergeCoordinator({ repositoryRoot: repo, baseRef: 'main' });

    await expect(coordinator.integrate([
      { taskId: 'evil', branchName: '-D main', verified: true },
    ])).rejects.toThrow(CortexValidationError);
  });
});
