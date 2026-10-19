import { assertLive, authorize, clampNumber, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import { canImport, failureResult, loadSdk, successResult, taskWorkspaceRoot } from './shared';

export const AUTOCANNON_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'autocannon',
  capability: 'performance',
  name: 'Autocannon',
  packageName: 'autocannon',
  version: '8.0.0',
  license: 'MIT',
  source: 'https://github.com/mcollina/autocannon',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'load-test an HTTP endpoint with the real Autocannon engine',
    'report requests per second, latency percentiles and error counts',
    'refuse any target that is not an explicitly authorised loopback URL',
  ],
  status: 'live-tested',
  limitations: [
    'Measures an already-running service; it does not profile application code.',
    'Only loopback targets are permitted, so remote benchmarking is deliberately unsupported.',
  ],
};

interface AutocannonResult {
  requests: { total: number; average: number; sent: number };
  latency: { average: number; p99: number; max: number };
  throughput: { average: number };
  errors: number;
  timeouts: number;
  non2xx: number;
}

interface AutocannonModule {
  default: (options: Record<string, unknown>) => Promise<AutocannonResult>;
  aggregateResult?: (result: AutocannonResult) => AutocannonResult;
}

export interface AutocannonAdapterOptions {
  /** Target URL; must be loopback. */
  url?: string;
  connections?: number;
  durationSeconds?: number;
  /** Minimum requests/second a result must reach to be considered a pass. */
  minRequestsPerSecond?: number;
  /** Maximum tolerated non-2xx responses. */
  maxNon2xx?: number;
  loadModule?: () => Promise<AutocannonModule>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** CORTEX performance SDK: real loopback load tests. */
export class AutocannonAdapter implements CortexSdkAdapter {
  readonly descriptor = AUTOCANNON_DESCRIPTOR;
  private readonly options: AutocannonAdapterOptions;
  private readonly loader: () => Promise<AutocannonModule>;

  constructor(options: AutocannonAdapterOptions = {}) {
    this.options = options;
    this.loader = options.loadModule ?? (() => loadSdk<AutocannonModule>('autocannon', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('autocannon');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'autocannon task');
    taskWorkspaceRoot(task);

    const url = this.resolveTarget(task);
    authorize(ctx, this.descriptor.id, 'network', `loopback load test against ${url.origin}`);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'Autocannon runs its load engine in-process');

    const connections = clampNumber(
      readNumber(task.options?.connections) ?? this.options.connections,
      10, 1, 1000, 'connections',
    );
    const duration = clampNumber(
      readNumber(task.options?.durationSeconds) ?? this.options.durationSeconds,
      2, 1, 60, 'durationSeconds',
    );

    let module: AutocannonModule;
    try {
      module = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    // `autocannon()` already returns a single aggregated run result. The
    // exported `aggregateResult()` merges an *array* of runs, so calling it
    // here with one object throws.
    const result = await module.default({
      url: url.toString(),
      connections,
      duration,
    });

    const minRps = clampNumber(
      readNumber(task.options?.minRequestsPerSecond) ?? this.options.minRequestsPerSecond,
      1, 1, 10_000_000, 'minRequestsPerSecond',
    );
    const maxNon2xx = clampNumber(
      readNumber(task.options?.maxNon2xx) ?? this.options.maxNon2xx,
      0, 0, 1_000_000, 'maxNon2xx',
    );

    const evidence = {
      target: url.toString(),
      connections,
      durationSeconds: duration,
      requestsPerSecond: Number(result.requests?.average ?? 0),
      requestsTotal: Number(result.requests?.total ?? 0),
      latencyAverageMs: Number(result.latency?.average ?? 0),
      latencyP99Ms: Number(result.latency?.p99 ?? 0),
      errors: Number(result.errors ?? 0),
      timeouts: Number(result.timeouts ?? 0),
      non2xx: Number(result.non2xx ?? 0),
      thresholds: { minRequestsPerSecond: minRps, maxNon2xx },
    };

    const breaches: string[] = [];
    if (evidence.requestsPerSecond < minRps) {
      breaches.push(`throughput ${evidence.requestsPerSecond}/s is below the ${minRps}/s threshold`);
    }
    if (evidence.non2xx > maxNon2xx) {
      breaches.push(`${evidence.non2xx} non-2xx responses exceed the ${maxNon2xx} limit`);
    }
    if (evidence.errors > 0 || evidence.timeouts > 0) {
      breaches.push(`${evidence.errors} errors and ${evidence.timeouts} timeouts were observed`);
    }

    if (breaches.length > 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        evidence,
        error: breaches.join('; '),
      });
    }

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'load-test', kind: 'metric', summary: `${evidence.requestsPerSecond} req/s` }],
      evidence,
    });
  }

  private resolveTarget(task: CortexSdkTask): URL {
    const candidate = (task.options?.url as string | undefined) ?? this.options.url;
    if (!candidate) throw new Error('A target URL is required for a load test.');
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error('The target URL is not a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Refusing to load-test ${url.protocol} targets; only http(s) is allowed.`);
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(
        `Refusing to load-test ${url.hostname}: only loopback targets are allowed.`,
      );
    }
    if (url.username || url.password) throw new Error('The target URL must not contain credentials.');
    return url;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
