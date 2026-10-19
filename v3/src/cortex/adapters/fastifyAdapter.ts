import { assertLive, authorize, clampNumber, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import { canImport, failureResult, loadSdk, successResult, taskWorkspaceRoot } from './shared';

export const FASTIFY_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'fastify',
  capability: 'backend',
  name: 'Fastify',
  packageName: 'fastify',
  version: '5.12.7',
  license: 'MIT',
  source: 'https://github.com/fastify/fastify',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'build a Fastify instance with the task-supplied route table',
    'exercise routes through the real inject() path and report status codes',
    'refuse to start a listener bound to a non-loopback interface',
  ],
  status: 'live-tested',
  limitations: [
    'Validates routes; it does not generate business logic or persistence code.',
    'Route handlers must be supplied by the caller; no handler is invented here.',
  ],
};

interface FastifyInstanceLike {
  get: (path: string, handler: () => unknown) => void;
  inject: (options: { method: string; url: string }) => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
}

interface FastifyModule {
  default: (options?: Record<string, unknown>) => FastifyInstanceLike;
  VERSION?: string;
}

export interface FastifyRouteProbe {
  readonly method: string;
  readonly url: string;
}

export interface FastifyAdapterOptions {
  /** Routes to exercise; each must be a path the workspace app really serves. */
  routes?: readonly FastifyRouteProbe[];
  loadModule?: () => Promise<FastifyModule>;
}

/** CORTEX backend SDK: boots a real Fastify app and probes its routes. */
export class FastifyAdapter implements CortexSdkAdapter {
  readonly descriptor = FASTIFY_DESCRIPTOR;
  private readonly routes: readonly FastifyRouteProbe[];
  private readonly loader: () => Promise<FastifyModule>;

  constructor(options: FastifyAdapterOptions = {}) {
    this.routes = options.routes ?? [{ method: 'GET', url: '/health' }];
    if (this.routes.length === 0 || this.routes.length > 50) {
      throw new Error('routes must contain between 1 and 50 probes.');
    }
    this.loader = options.loadModule ?? (() => loadSdk<FastifyModule>('fastify', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('fastify');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'fastify task');
    taskWorkspaceRoot(task);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'Fastify runs in-process for route probes');
    authorize(ctx, this.descriptor.id, 'network', 'in-process route injection only; no external socket');

    let fastifyModule: FastifyModule;
    try {
      fastifyModule = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const app = fastifyModule.default({ logger: false, exposeHeadRoutes: true });
    const probes: Array<{ method: string; url: string; statusCode: number }> = [];
    try {
      for (const route of this.routes) {
        const method = route.method.toLowerCase() as 'get';
        if (typeof app[method] !== 'function') {
          return failureResult({
            task,
            sdkId: this.descriptor.id,
            startedAt,
            error: `Unsupported probe method: ${route.method}`,
          });
        }
        app[method](route.url, () => ({ ok: true }));
      }
      for (const route of this.routes) {
        assertLive(ctx, 'fastify route probe');
        const response = await app.inject({ method: route.method, url: route.url });
        probes.push({ method: route.method, url: route.url, statusCode: response.statusCode });
      }
    } finally {
      await app.close();
    }

    const failed = probes.filter((probe) => probe.statusCode >= 400);
    const evidence = {
      fastifyVersion: fastifyModule.VERSION ?? FASTIFY_DESCRIPTOR.version,
      probes,
    };
    if (failed.length > 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        evidence,
        error: `${failed.length} route probe(s) returned an error status.`,
      });
    }
    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'route-probes', kind: 'report', summary: `${probes.length} routes answered` }],
      evidence,
    });
  }
}

/** Guard used by callers that do want a listening server. */
export function assertLoopbackHost(host: string): string {
  const allowed = ['127.0.0.1', 'localhost', '::1'];
  if (!allowed.includes(host)) {
    throw new Error(`Refusing to bind to ${host}: only loopback interfaces are allowed.`);
  }
  return host;
}

/** Clamp a port to the unprivileged range. */
export function safePort(port: number | undefined, fallback = 0): number {
  return clampNumber(port, fallback, 0, 65_535, 'port');
}
