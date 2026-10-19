import path from 'node:path';
import { existsSync } from 'node:fs';
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
  listWorkspaceFiles,
  loadSdk,
  resolveInsideWorkspace,
  safeSnippet,
  successResult,
  taskWorkspaceRoot,
} from './shared';

export const TYPEDOC_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'typedoc',
  capability: 'documentation',
  name: 'TypeDoc',
  packageName: 'typedoc',
  version: '0.27.9',
  license: 'Apache-2.0',
  source: 'https://github.com/TypeStrong/TypeDoc',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'convert real TypeScript entry points into an API reflection model',
    'report every documented export and its kind',
    'refuse to document a workspace with no TypeScript sources',
  ],
  status: 'live-tested',
  limitations: [
    'Documents exported symbols; it does not write prose guides.',
    'Requires a TypeScript version in the range TypeDoc 0.27 declares as a peer.',
  ],
};

interface TypeDocModule {
  Application: {
    bootstrapWithPlugins: (
      options: Record<string, unknown>,
      plugins?: unknown[],
    ) => Promise<{
      convert: () => Promise<TypeDocProject | undefined>;
      generateDocs?: () => Promise<unknown>;
    }>;
  };
}

interface TypeDocReflection {
  name?: string;
  kindString?: string;
  children?: TypeDocReflection[];
}

type TypeDocProject = TypeDocReflection;

export interface TypeDocAdapterOptions {
  /** Entry points relative to the workspace; discovered when omitted. */
  entryPoints?: readonly string[];
  /** Output directory relative to the workspace. */
  outDir?: string;
  loadModule?: () => Promise<TypeDocModule>;
}

/** CORTEX documentation SDK: real TypeDoc reflection over the workspace. */
export class TypeDocAdapter implements CortexSdkAdapter {
  readonly descriptor = TYPEDOC_DESCRIPTOR;
  private readonly entryPoints: readonly string[];
  private readonly outDir: string;
  private readonly loader: () => Promise<TypeDocModule>;

  constructor(options: TypeDocAdapterOptions = {}) {
    this.entryPoints = options.entryPoints ?? [];
    this.outDir = options.outDir ?? 'cortex-docs';
    if (this.outDir.includes('..') || this.outDir.startsWith('/')) {
      throw new Error('outDir must be a relative directory inside the workspace.');
    }
    this.loader = options.loadModule ?? (() => loadSdk<TypeDocModule>('typedoc', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('typedoc');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'typedoc task');
    const root = taskWorkspaceRoot(task);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'TypeDoc loads the TypeScript compiler in-process');
    authorize(ctx, this.descriptor.id, 'write-workspace', `TypeDoc may write ${this.outDir}/`);

    const entries = this.entryPoints.length > 0
      ? this.entryPoints.map((entry) => resolveInsideWorkspace(task, entry, 'entryPoints entry'))
      : listWorkspaceFiles(root, { extensions: ['.ts', '.tsx'], maxFiles: 50 })
          .filter((entry) => !entry.includes('.test.') && !entry.includes('.spec.'))
          .map((entry) => path.join(root, entry));

    if (entries.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'No TypeScript entry points were found in the workspace.',
      });
    }

    let module: TypeDocModule;
    try {
      module = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const out = path.join(root, this.outDir);
    const app = await module.Application.bootstrapWithPlugins(
      {
        entryPoints: entries,
        out,
        logLevel: 'Error',
        skipErrorChecking: true,
        readme: 'none',
        // Never let a workspace tsconfig silently redirect the output: the
        // caller's explicit outDir wins.
        tsconfig: existsSync(path.join(root, 'tsconfig.json')) ? path.join(root, 'tsconfig.json') : undefined,
      },
      [],
    );

    const project = await app.convert();
    if (!project) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'TypeDoc could not convert the entry points.',
      });
    }

    const symbols = flattenReflections(project);
    if (symbols.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'TypeDoc converted the project but documented no exported symbols.',
      });
    }

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'api-reflection', kind: 'report', path: this.outDir, summary: `${symbols.length} symbols` }],
      evidence: {
        entryPoints: entries.length,
        symbols: symbols.slice(0, 50).map((symbol) => safeSnippet(symbol, 160)),
      },
    });
  }
}

function flattenReflections(project: TypeDocProject): string[] {
  const out: string[] = [];
  const walk = (reflection: TypeDocReflection, depth: number): void => {
    if (depth > 4 || out.length > 500) return;
    if (reflection.name) out.push(`${reflection.kindString ?? 'Reflection'} ${reflection.name}`);
    for (const child of reflection.children ?? []) walk(child, depth + 1);
  };
  walk(project, 0);
  return out;
}
