import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  OpenHandsSwarmTask,
  OpenHandsWorkspace,
  OpenHandsWorkspaceProvisioner,
} from './OpenHandsSwarm';

const execFile = promisify(nodeExecFile);

export interface GitWorktreeProvisionerOptions {
  /** Host path to the repository that agents should modify. */
  repositoryRoot: string;
  /** Host path mounted into the Agent Server as serverWorkspaceRoot. */
  hostWorkspaceRoot: string;
  /** Absolute path for the same directory inside Agent Server (e.g. /workspace). */
  serverWorkspaceRoot: string;
  /** Existing base branch/ref from which each isolated branch is created. */
  baseRef?: string;
  /** Optional test seam; production uses execFile('git', args). */
  runGit?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

function safeSegment(value: string, field: string): string {
  const safe = value.trim();
  if (!safe || safe.length > 80 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(safe) || safe === '.' || safe === '..') {
    throw new Error(field + ' must be a safe path/branch segment (letters, numbers, dot, underscore, hyphen).');
  }
  return safe;
}

function absoluteWithoutTraversal(value: string, field: string): string {
  if (!path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(field + ' must be an absolute path without traversal segments.');
  }
  return path.resolve(value);
}

/**
 * Creates one actual Git branch + worktree per OpenHands task.
 * The host workspace root must be mounted into the Agent Server at the configured
 * serverWorkspaceRoot; this class never pretends that host paths are container paths.
 */
export class OpenHandsGitWorktreeProvisioner implements OpenHandsWorkspaceProvisioner {
  private readonly repositoryRoot: string;
  private readonly hostWorkspaceRoot: string;
  private readonly serverWorkspaceRoot: string;
  private readonly baseRef: string;
  private readonly runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: GitWorktreeProvisionerOptions) {
    this.repositoryRoot = absoluteWithoutTraversal(options.repositoryRoot, 'repositoryRoot');
    this.hostWorkspaceRoot = absoluteWithoutTraversal(options.hostWorkspaceRoot, 'hostWorkspaceRoot');
    this.serverWorkspaceRoot = absoluteWithoutTraversal(options.serverWorkspaceRoot, 'serverWorkspaceRoot');
    this.baseRef = options.baseRef ?? 'HEAD';
    this.runGit = options.runGit ?? (async (args) => {
      const result = await execFile('git', args, { cwd: this.repositoryRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr };
    });
    if (this.serverWorkspaceRoot === '/') {
      throw new Error('serverWorkspaceRoot must not be the filesystem root.');
    }
  }

  async prepare(task: OpenHandsSwarmTask): Promise<OpenHandsWorkspace> {
    const taskId = safeSegment(task.taskId, 'taskId');
    const branchName = task.branchName;
    if (!branchName || branchName.length > 180 || branchName.startsWith('-') ||
      branchName.split('/').some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/.test(part))) {
      throw new Error('branchName contains unsupported Git ref characters.');
    }
    const requestedPath = path.resolve(task.workingDirectory);
    const relativePath = path.relative(this.hostWorkspaceRoot, requestedPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('workingDirectory must be a unique child directory of hostWorkspaceRoot.');
    }
    if (relativePath.split(path.sep)[0] !== taskId) {
      throw new Error('workingDirectory must begin with the taskId to prevent workspace collisions.');
    }
    await fs.mkdir(this.hostWorkspaceRoot, { recursive: true });
    await fs.mkdir(path.dirname(requestedPath), { recursive: true });
    try {
      await fs.access(requestedPath);
      throw new Error('workingDirectory already exists; refusing to reuse another task workspace.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // Confirm the base ref exists and the target branch does not already exist.
    await this.runGit(['rev-parse', '--verify', this.baseRef + '^{commit}']);
    const branch = await this.runGit(['branch', '--list', branchName]);
    if (branch.stdout.trim()) throw new Error('Git branch already exists: ' + branchName);

    try {
      await this.runGit(['worktree', 'add', '-b', branchName, requestedPath, this.baseRef]);
    } catch (error) {
      // Do not remove an arbitrary directory; only clean up the path if Git created it.
      try {
        const stat = await fs.lstat(requestedPath);
        if (stat.isDirectory()) {
          const marker = await fs.stat(path.join(requestedPath, '.git'));
          if (marker.isFile()) await this.runGit(['worktree', 'remove', '--force', requestedPath]);
        }
      } catch {
        // Preserve the original Git error; cleanup is best effort.
      }
      throw new Error('Could not create isolated Git worktree for task ' + taskId + ': ' +
        (error instanceof Error ? error.message : 'unknown git error'));
    }

    const serverPath = path.posix.join(this.serverWorkspaceRoot, ...relativePath.split(path.sep));
    return { branchName, workingDirectory: serverPath };
  }
}
