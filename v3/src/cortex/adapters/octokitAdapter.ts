import { assertLive, authorize, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import { canImport, failureResult, loadSdk, safeSnippet, successResult, taskWorkspaceRoot } from './shared';

export const OCTOKIT_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'octokit',
  capability: 'review',
  name: 'Octokit REST (GitHub)',
  packageName: '@octokit/rest',
  version: '22.0.1',
  license: 'MIT',
  source: 'https://github.com/octokit/rest.js',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'read a pull request, its files and its review threads',
    'summarise a diff into per-file change counts for review',
    'report mergeability without ever merging',
  ],
  status: 'mock-tested',
  limitations: [
    'Read-only by design: no merge, close, force-push or comment API is called.',
    'Requires a token with read access; no token is read from the repository.',
    'No live GitHub call was made in this repository, so only mocked tests exist.',
  ],
};

interface OctokitModule {
  Octokit: new (options?: Record<string, unknown>) => OctokitClient;
}

interface OctokitClient {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;
}

export interface OctokitAdapterOptions {
  /** Token is injected by the operator; never stored in the repository. */
  token?: string;
  /** Repository owner. */
  owner?: string;
  /** Repository name. */
  repo?: string;
  /** Base URL for GitHub Enterprise. */
  baseUrl?: string;
  loadModule?: () => Promise<OctokitModule>;
}

/** CORTEX review SDK: read-only pull request inspection through Octokit. */
export class OctokitAdapter implements CortexSdkAdapter {
  readonly descriptor = OCTOKIT_DESCRIPTOR;
  private readonly options: OctokitAdapterOptions;
  private readonly loader: () => Promise<OctokitModule>;

  constructor(options: OctokitAdapterOptions = {}) {
    this.options = options;
    this.loader = options.loadModule ?? (() => loadSdk<OctokitModule>('@octokit/rest', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    if (!(await canImport('@octokit/rest'))) return false;
    // Without a token the adapter cannot do real work, so it reports itself as
    // unavailable rather than failing at request time.
    return Boolean(this.options.token);
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'octokit task');
    taskWorkspaceRoot(task);

    const token = this.options.token;
    if (!token) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'No GitHub token was provided to the review adapter.',
      });
    }

    const owner = (task.options?.owner as string | undefined) ?? this.options.owner;
    const repo = (task.options?.repo as string | undefined) ?? this.options.repo;
    const pullNumber = readNumber(task.options?.pullNumber);
    if (!owner || !repo || !pullNumber) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'owner, repo and pullNumber are required to review a pull request.',
      });
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'owner and repo must contain only letters, numbers, dot, underscore or hyphen.',
      });
    }
    if (!Number.isInteger(pullNumber) || pullNumber < 1) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'pullNumber must be a positive integer.',
      });
    }

    authorize(ctx, this.descriptor.id, 'network', `read pull request ${owner}/${repo}#${pullNumber}`);
    authorize(ctx, this.descriptor.id, 'read-secret', 'use the injected GitHub token for read-only access');

    let module: OctokitModule;
    try {
      module = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const client = new module.Octokit({
      auth: token,
      baseUrl: this.options.baseUrl,
      userAgent: 'cortex-agent-os',
    });

    const [pull, files] = await Promise.all([
      client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: pullNumber,
      }),
      client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
        owner, repo, pull_number: pullNumber, per_page: 100,
      }),
    ]);

    assertLive(ctx, 'octokit review');

    const pullData = pull.data as {
      number?: number;
      title?: string;
      state?: string;
      draft?: boolean;
      mergeable?: boolean | null;
      additions?: number;
      deletions?: number;
      changed_files?: number;
    };
    const fileList = Array.isArray(files.data)
      ? (files.data as Array<{ filename?: string; status?: string; additions?: number; deletions?: number }>)
      : [];

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'pull-request-review', kind: 'report', summary: `${fileList.length} changed files` }],
      evidence: {
        pullRequest: {
          number: pullData.number,
          state: pullData.state,
          draft: pullData.draft,
          mergeable: pullData.mergeable,
          additions: pullData.additions,
          deletions: pullData.deletions,
          changedFiles: pullData.changed_files,
          title: safeSnippet(String(pullData.title ?? ''), 200),
        },
        files: fileList.slice(0, 100).map((file) => ({
          filename: safeSnippet(String(file.filename ?? ''), 200),
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
        })),
        // Explicit: this adapter never writes to GitHub.
        performedWrites: false,
      },
    });
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
