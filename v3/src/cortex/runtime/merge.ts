import { CortexValidationError } from '../errors';
import { assertSafeGitRef, assertSafeSegment, safeErrorMessage } from '../security';

/**
 * A change set the coordinator is allowed to consider for integration: one task
 * that already passed an independent verifier, and the branch it produced.
 */
export interface CortexMergeCandidate {
  readonly taskId: string;
  readonly branchName: string;
  /** True only when the swarm's verifier ran and passed for this task. */
  readonly verified: boolean;
  /** Branch names that must be integrated before this one. */
  readonly dependsOn?: readonly string[];
}

export interface CortexMergeCoordinatorOptions {
  /** Repository whose integration branch is written. */
  repositoryRoot: string;
  /** Branch every verified candidate is merged into. Defaults to `cortex/integration`. */
  integrationBranch?: string;
  /** Ref the integration branch is (re)created from. Defaults to `main`. */
  baseRef?: string;
  /** Injectable git runner for tests; production uses execFile('git'). */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export type CortexMergeStatus =
  | 'merged'
  | 'conflict'
  | 'skipped-unverified'
  | 'failed';

export interface CortexMergeResult {
  readonly taskId: string;
  readonly branchName: string;
  readonly status: CortexMergeStatus;
  /** Files that conflicted, when status is `conflict`. */
  readonly conflictedFiles?: readonly string[];
  readonly error?: string;
}

export interface CortexMergeReport {
  readonly integrationBranch: string;
  readonly baseRef: string;
  /** True only when every candidate was merged, none was skipped, none failed. */
  readonly complete: boolean;
  readonly results: readonly CortexMergeResult[];
}

/**
 * Integrates verified agent branches into one integration branch.
 *
 * Two invariants are enforced, both tested:
 *  1. A branch is never merged unless its candidate is marked verified. The
 *     coordinator cannot see a conversation, only the `verified` flag the
 *     swarm set, so "the agent said it was done" can never reach this layer.
 *  2. On conflict the merge is aborted and the integration branch is left on the
 *     last good merge, so a half-applied tree is never committed.
 *
 * The coordinator is idempotent across runs: it recreates the integration
 * branch from `baseRef` each time instead of merging into a stale tree.
 */
export class CortexMergeCoordinator {
  private readonly repositoryRoot: string;
  private readonly integrationBranch: string;
  private readonly baseRef: string;
  private readonly runGit: NonNullable<CortexMergeCoordinatorOptions['runGit']>;

  constructor(options: CortexMergeCoordinatorOptions) {
    this.repositoryRoot = options.repositoryRoot;
    this.integrationBranch = assertSafeGitRef(options.integrationBranch ?? 'cortex/integration', 'integrationBranch');
    this.baseRef = assertSafeGitRef(options.baseRef ?? 'main', 'baseRef');
    this.runGit = options.runGit ?? (async (args, cwd) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        const result = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
        };
      }
    });
  }

  async integrate(candidates: readonly CortexMergeCandidate[]): Promise<CortexMergeReport> {
    const ordered = this.order(candidates);

    // Recreate the integration branch from the base ref so repeated runs do not
    // stack on a previous partial integration.
    const baseCheck = await this.runGit(['rev-parse', '--verify', `${this.baseRef}^{commit}`], this.repositoryRoot);
    if (baseCheck.exitCode !== 0) {
      throw new CortexValidationError(`Base ref ${this.baseRef} does not resolve to a commit.`);
    }
    const reset = await this.runGit(['checkout', '-B', this.integrationBranch, this.baseRef], this.repositoryRoot);
    if (reset.exitCode !== 0) {
      throw new CortexValidationError(
        `Could not create integration branch ${this.integrationBranch}: ${safeErrorMessage(reset.stderr, 200)}`,
      );
    }

    const results: CortexMergeResult[] = [];
    let complete = true;

    for (const candidate of ordered) {
      if (!candidate.verified) {
        // The whole point of this layer: unverified output never lands.
        results.push({
          taskId: candidate.taskId,
          branchName: candidate.branchName,
          status: 'skipped-unverified',
          error: 'Candidate was not verified; refusing to integrate it.',
        });
        complete = false;
        continue;
      }

      const branchExists = await this.runGit(
        ['rev-parse', '--verify', `${candidate.branchName}^{commit}`],
        this.repositoryRoot,
      );
      if (branchExists.exitCode !== 0) {
        results.push({
          taskId: candidate.taskId,
          branchName: candidate.branchName,
          status: 'failed',
          error: 'Branch does not resolve to a commit.',
        });
        complete = false;
        continue;
      }

      const merge = await this.runGit(
        ['merge', '--no-ff', '--no-edit', candidate.branchName],
        this.repositoryRoot,
      );
      if (merge.exitCode !== 0) {
        // Leave the integration branch on the last good merge, never a
        // half-applied tree.
        const conflictedFiles = await this.conflictedFiles();
        await this.runGit(['merge', '--abort'], this.repositoryRoot);
        results.push({
          taskId: candidate.taskId,
          branchName: candidate.branchName,
          status: 'conflict',
          conflictedFiles,
          error: safeErrorMessage(merge.stderr || merge.stdout, 300),
        });
        complete = false;
        continue;
      }

      results.push({ taskId: candidate.taskId, branchName: candidate.branchName, status: 'merged' });
    }

    return { integrationBranch: this.integrationBranch, baseRef: this.baseRef, complete, results };
  }

  private async conflictedFiles(): Promise<string[]> {
    const result = await this.runGit(['diff', '--name-only', '--diff-filter=U'], this.repositoryRoot);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 200);
  }

  /**
   * Stable topological order: dependencies first, otherwise input order.
   * A dependency cycle or an unknown dependency is a hard error, because
   * guessing an order could integrate a change before what it builds on.
   */
  private order(candidates: readonly CortexMergeCandidate[]): CortexMergeCandidate[] {
    const ids = new Set<string>();
    for (const candidate of candidates) {
      const taskId = assertSafeSegment(candidate.taskId, 'taskId', 80);
      if (ids.has(taskId)) {
        throw new CortexValidationError(`taskId ${taskId} appears more than once in the merge batch.`);
      }
      ids.add(taskId);
      assertSafeGitRef(candidate.branchName, 'branchName');
    }

    const byId = new Map(candidates.map((candidate) => [candidate.taskId, candidate]));
    for (const candidate of candidates) {
      for (const dependency of candidate.dependsOn ?? []) {
        if (!byId.has(dependency)) {
          throw new CortexValidationError(
            `task ${candidate.taskId} depends on ${dependency}, which is not in the merge batch.`,
          );
        }
      }
    }

    const ordered: CortexMergeCandidate[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (candidate: CortexMergeCandidate): void => {
      if (done.has(candidate.taskId)) return;
      if (visiting.has(candidate.taskId)) {
        throw new CortexValidationError(`dependency cycle detected at task ${candidate.taskId}.`);
      }
      visiting.add(candidate.taskId);
      for (const dependency of candidate.dependsOn ?? []) visit(byId.get(dependency)!);
      visiting.delete(candidate.taskId);
      done.add(candidate.taskId);
      ordered.push(candidate);
    };
    for (const candidate of candidates) visit(candidate);
    return ordered;
  }
}
