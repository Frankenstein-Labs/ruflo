import path from 'node:path';
import fs from 'node:fs/promises';
import { assertSafeGitRef, assertSafeSegment, assertUsableRoot, safeExec, safeErrorMessage } from '../security';
import { CortexValidationError } from '../errors';
import type { CortexWorkspaceScope } from '../types';

export const CORTEX_WORKSPACE_LIMITS = {
  maxConcurrentWorkspaces: 10,
  maxPathDepth: 8,
} as const;

export type CortexWorkspaceStatus =
  | 'created'
  | 'reused'
  | 'conflict'
  | 'released'
  | 'missing';

export interface CortexWorkspaceRecord {
  readonly taskId: string;
  readonly branchName: string;
  readonly hostPath: string;
  readonly sandboxPath?: string;
  status: CortexWorkspaceStatus;
  createdAt: string;
  releasedAt?: string;
}

export interface CortexWorkspaceManagerOptions {
  /** Absolute host root; every workspace is a child of this directory. */
  hostRoot: string;
  /** Absolute path the same directory has inside a sandbox, if any. */
  sandboxRoot?: string;
  /** Existing ref each isolated branch is created from. */
  baseRef?: string;
  /** Repository whose worktrees are created. Defaults to hostRoot's repo. */
  repositoryRoot?: string;
  maxConcurrent?: number;
  /** Injectable git runner for tests; production uses execFile('git'). */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  now?: () => Date;
}

/**
 * Creates one isolated Git branch + worktree per task and enforces the
 * workspace policy: unique paths, no traversal, no filesystem root, no two
 * writers in the same worktree, and bounded concurrency.
 */
export class CortexWorkspaceManager {
  private readonly hostRoot: string;
  private readonly sandboxRoot?: string;
  private readonly baseRef: string;
  private readonly repositoryRoot: string;
  private readonly maxConcurrent: number;
  private readonly runGit: NonNullable<CortexWorkspaceManagerOptions['runGit']>;
  private readonly now: () => Date;
  private readonly records = new Map<string, CortexWorkspaceRecord>();
  /** taskId -> workspace path, so a path can only ever have one owner. */
  private readonly ownersByPath = new Map<string, string>();

  constructor(options: CortexWorkspaceManagerOptions) {
    this.hostRoot = assertUsableRoot(options.hostRoot, 'hostRoot');
    this.sandboxRoot = options.sandboxRoot;
    if (this.sandboxRoot !== undefined) {
      const normalized = path.posix.resolve(this.sandboxRoot);
      if (normalized === '/') {
        throw new CortexValidationError('sandboxRoot must not be the container filesystem root.');
      }
    }
    this.baseRef = assertSafeGitRef(options.baseRef ?? 'HEAD', 'baseRef');
    this.repositoryRoot = options.repositoryRoot
      ? assertUsableRoot(options.repositoryRoot, 'repositoryRoot')
      : this.hostRoot;
    this.maxConcurrent = options.maxConcurrent ?? CORTEX_WORKSPACE_LIMITS.maxConcurrentWorkspaces;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 32) {
      throw new CortexValidationError('maxConcurrent must be an integer between 1 and 32.');
    }
    this.runGit = options.runGit ?? (async (args, cwd) => {
      const result = await safeExec({ command: 'git', args, cwd, timeoutMs: 60_000 });
      return result;
    });
    this.now = options.now ?? (() => new Date());
  }

  /** Live workspaces, so the UI can show what is currently checked out. */
  active(): CortexWorkspaceRecord[] {
    return [...this.records.values()].filter((record) => record.status === 'created');
  }

  record(taskId: string): CortexWorkspaceRecord | undefined {
    return this.records.get(taskId);
  }

  /**
   * Provision an isolated workspace. The branch name and directory are derived
   * from the task id, so two tasks can never share a worktree.
   */
  async prepare(taskId: string, options: { branchName?: string } = {}): Promise<CortexWorkspaceRecord> {
    const safeTaskId = assertSafeSegment(taskId, 'taskId', 80);
    const existing = this.records.get(safeTaskId);
    if (existing && existing.status === 'created') {
      existing.status = 'reused';
      return existing;
    }
    if (this.active().length >= this.maxConcurrent) {
      throw new CortexValidationError(
        `CORTEX allows at most ${this.maxConcurrent} concurrent workspaces; release one before starting another.`,
      );
    }

    const branchName = assertSafeGitRef(options.branchName ?? `cortex/${safeTaskId}`, 'branchName');
    const hostPath = path.join(this.hostRoot, safeTaskId, 'worktree');
    if (hostPath.split(path.sep).length - this.hostRoot.split(path.sep).length > CORTEX_WORKSPACE_LIMITS.maxPathDepth) {
      throw new CortexValidationError('Workspace path is nested too deeply.');
    }
    const owner = this.ownersByPath.get(hostPath);
    if (owner && owner !== safeTaskId) {
      throw new CortexValidationError(`Workspace ${hostPath} already belongs to task ${owner}.`);
    }

    await fs.mkdir(path.dirname(hostPath), { recursive: true });
    if (await exists(hostPath)) {
      throw new CortexValidationError(
        `Workspace path already exists for task ${safeTaskId}; refusing to reuse another task's worktree.`,
      );
    }

    const baseCheck = await this.runGit(['rev-parse', '--verify', `${this.baseRef}^{commit}`], this.repositoryRoot);
    if (baseCheck.exitCode !== 0) {
      throw new CortexValidationError(`Base ref ${this.baseRef} does not resolve to a commit.`);
    }
    const branchCheck = await this.runGit(['branch', '--list', '--', branchName], this.repositoryRoot);
    if (branchCheck.stdout.trim()) {
      throw new CortexValidationError(`Git branch ${branchName} already exists.`);
    }

    const created = await this.runGit(
      ['worktree', 'add', '-b', branchName, '--', hostPath, this.baseRef],
      this.repositoryRoot,
    );
    if (created.exitCode !== 0) {
      throw new CortexValidationError(
        `git worktree add failed for task ${safeTaskId}: ${safeErrorMessage(created.stderr, 200)}`,
      );
    }

    this.ownersByPath.set(hostPath, safeTaskId);
    const record: CortexWorkspaceRecord = {
      taskId: safeTaskId,
      branchName,
      hostPath,
      sandboxPath: this.sandboxRoot
        ? path.posix.join(this.sandboxRoot, safeTaskId, 'worktree')
        : undefined,
      status: 'created',
      createdAt: this.now().toISOString(),
    };
    this.records.set(safeTaskId, record);
    return record;
  }

  /** The scope an adapter receives; it never sees the raw host path. */
  scopeFor(record: CortexWorkspaceRecord): CortexWorkspaceScope {
    return {
      hostRoot: record.hostPath,
      sandboxRoot: record.sandboxPath,
      branchName: record.branchName,
    };
  }

  /** Files changed in the workspace, from real Git state. */
  async changedFiles(record: CortexWorkspaceRecord): Promise<string[]> {
    const result = await this.runGit(
      ['status', '--porcelain', '--untracked-files=all'],
      record.hostPath,
    );
    if (result.exitCode !== 0) {
      throw new CortexValidationError('Could not read the workspace Git status.');
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.includes(' -> ') ? line.split(' -> ').pop()! : line))
      .slice(0, 1000);
  }

  /** Whitespace/conflict-marker check that never mutates the worktree. */
  async diffCheck(record: CortexWorkspaceRecord): Promise<{ clean: boolean; detail?: string }> {
    const result = await this.runGit(['diff', '--check'], record.hostPath);
    if (result.exitCode === 0) return { clean: true };
    return { clean: false, detail: safeErrorMessage(result.stdout || result.stderr, 300) };
  }

  /** Detect whether two active workspaces would touch the same file. */
  async conflicts(records: readonly CortexWorkspaceRecord[]): Promise<Array<{ a: string; b: string; files: string[] }>> {
    const fileSets = new Map<string, Set<string>>();
    for (const record of records) {
      if (record.status !== 'created') continue;
      fileSets.set(record.taskId, new Set(await this.changedFiles(record)));
    }
    const conflicts: Array<{ a: string; b: string; files: string[] }> = [];
    const ids = [...fileSets.keys()];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = fileSets.get(ids[i])!;
        const b = fileSets.get(ids[j])!;
        const shared = [...a].filter((file) => b.has(file));
        if (shared.length > 0) conflicts.push({ a: ids[i], b: ids[j], files: shared.slice(0, 50) });
      }
    }
    return conflicts;
  }

  /**
   * Commit everything the agent left in the worktree onto its branch.
   *
   * Callers must have verified the result first: the swarm releases the
   * worktree in its finally block, so an uncommitted change is destroyed before
   * a merge coordinator could ever see it. Returns the commit sha, or undefined
   * when the worktree had no changes (nothing to commit is not an error).
   */
  async commit(
    taskId: string,
    options: { message?: string } = {},
  ): Promise<{ committed: boolean; commitSha?: string }> {
    const record = this.records.get(taskId);
    if (!record) throw new CortexValidationError(`No workspace is recorded for task ${taskId}.`);
    if (record.status !== 'created' && record.status !== 'reused') {
      throw new CortexValidationError(`Workspace for task ${taskId} is not active.`);
    }
    const changes = await this.changedFiles(record);
    if (changes.length === 0) return { committed: false };

    const add = await this.runGit(['add', '--all'], record.hostPath);
    if (add.exitCode !== 0) {
      throw new CortexValidationError(`git add failed for task ${taskId}: ${safeErrorMessage(add.stderr, 200)}`);
    }
    const message = (options.message ?? `cortex(${taskId}): agent changes`).slice(0, 200);
    const commit = await this.runGit(
      ['-c', 'user.name=CORTEX', '-c', 'user.email=cortex@local', 'commit', '-q', '-m', message],
      record.hostPath,
    );
    if (commit.exitCode !== 0) {
      throw new CortexValidationError(`git commit failed for task ${taskId}: ${safeErrorMessage(commit.stderr, 200)}`);
    }
    const head = await this.runGit(['rev-parse', 'HEAD'], record.hostPath);
    return { committed: true, commitSha: head.stdout.trim() };
  }

  /** Remove the worktree and branch. Callers must have verified the result. */
  async release(taskId: string, options: { deleteBranch?: boolean } = {}): Promise<CortexWorkspaceRecord> {
    const record = this.records.get(taskId);
    if (!record) throw new CortexValidationError(`No workspace is recorded for task ${taskId}.`);
    if (record.status === 'released') return record;

    const removed = await this.runGit(['worktree', 'remove', '--force', '--', record.hostPath], this.repositoryRoot);
    if (removed.exitCode !== 0) {
      throw new CortexValidationError(
        `Could not remove worktree for task ${taskId}: ${safeErrorMessage(removed.stderr, 200)}`,
      );
    }
    if (options.deleteBranch) {
      await this.runGit(['branch', '-D', '--', record.branchName], this.repositoryRoot);
    }
    this.ownersByPath.delete(record.hostPath);
    record.status = 'released';
    record.releasedAt = this.now().toISOString();
    return record;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
