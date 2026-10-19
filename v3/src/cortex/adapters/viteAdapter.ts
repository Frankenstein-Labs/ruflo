import { CortexValidationError } from '../errors';
import { assertLive, authorize, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import {
  canImport,
  failureResult,
  loadSdk,
  listWorkspaceFiles,
  safeSnippet,
  successResult,
  taskWorkspaceRoot,
} from './shared';

export const VITE_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'vite',
  capability: 'frontend',
  name: 'Vite',
  packageName: 'vite',
  version: '8.3.4',
  license: 'MIT',
  source: 'https://github.com/vitejs/vite',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'build a frontend workspace with the real Vite pipeline',
    'report produced bundles and their sizes',
    'fail the task when the build fails, instead of reporting success',
  ],
  status: 'live-tested',
  limitations: [
    'Builds the project; it does not author React/TSX source itself.',
    'Does not run accessibility checks; that is the axe-core integration slot.',
  ],
};

interface ViteModule {
  build: (options: Record<string, unknown>) => Promise<unknown>;
  version: string;
}

export interface ViteAdapterOptions {
  /** Relative output directory inside the workspace. */
  outDir?: string;
  loadModule?: () => Promise<ViteModule>;
}

/** CORTEX frontend SDK: real Vite builds inside the task workspace. */
export class ViteAdapter implements CortexSdkAdapter {
  readonly descriptor = VITE_DESCRIPTOR;
  private readonly outDir: string;
  private readonly loader: () => Promise<ViteModule>;

  constructor(options: ViteAdapterOptions = {}) {
    this.outDir = options.outDir ?? 'dist';
    if (this.outDir.includes('..') || this.outDir.startsWith('/')) {
      throw new CortexValidationError('outDir must be a relative directory inside the workspace.');
    }
    this.loader = options.loadModule ?? (() => loadSdk<ViteModule>('vite', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('vite');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'vite task');
    const root = taskWorkspaceRoot(task);
    authorize(ctx, this.descriptor.id, 'write-workspace', `Vite writes ${this.outDir}/ inside the workspace`);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'Vite build runs in-process');

    let vite: ViteModule;
    try {
      vite = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const entryPoints = listWorkspaceFiles(root, { extensions: ['.html'], maxFiles: 20 });
    const output = await vite.build({
      root,
      logLevel: 'silent',
      configFile: false,
      build: { outDir: this.outDir, emptyOutDir: true, write: true },
    });

    const chunks = Array.isArray(output)
      ? output.flatMap((item) => ((item as { output?: unknown[] }).output ?? []))
      : ((output as { output?: unknown[] }).output ?? []);
    const names = chunks
      .map((chunk) => (chunk as { fileName?: string }).fileName)
      .filter((name): name is string => typeof name === 'string');

    if (names.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        evidence: { viteVersion: vite.version, emitted: 0, htmlEntryPoints: entryPoints.length },
        error: 'Vite produced no build output.',
      });
    }

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [
        { name: 'build-output', kind: 'report', path: `${this.outDir}/`, summary: `${names.length} emitted files` },
      ],
      evidence: {
        viteVersion: vite.version,
        emitted: names.length,
        hasHtml: names.includes('index.html'),
        htmlEntryPoints: entryPoints.length,
        sample: names.slice(0, 10).map((name) => safeSnippet(name, 120)),
      },
    });
  }
}
