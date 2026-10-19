import path from 'node:path';
import { existsSync } from 'node:fs';
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
  listWorkspaceFiles,
  loadSdk,
  resolveInsideWorkspace,
  safeSnippet,
  successResult,
  taskWorkspaceRoot,
} from './shared';

/**
 * A no-op Vitest reporter. Vitest always adds its own console reporter unless
 * one is supplied, and this adapter reports results through `vitest.state`, so
 * the default output would otherwise be duplicated into the caller's console.
 */
const SILENT_REPORTER = {
  onInit: () => {},
  onPathsCollected: () => {},
  onCollected: () => {},
  onFinished: () => {},
  onTaskUpdate: () => {},
  onUserConsoleLog: () => {},
  onProcessTimeout: () => {},
  onWatcherStart: () => {},
  onWatcherRerun: () => {},
  onTestRemoved: () => {},
  onServerRestart: () => {},
};

export const VITEST_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'vitest',
  capability: 'testing',
  name: 'Vitest',
  packageName: 'vitest',
  version: '4.1.8',
  license: 'MIT',
  source: 'https://github.com/vitest-dev/vitest',
  registry: 'npm',
  dependencyType: 'dependency',
  capabilities: [
    'run a real Vitest suite through the programmatic Node API',
    'report passed and failed test counts from the run result',
    'fail the CORTEX task when any test fails',
  ],
  status: 'live-tested',
  limitations: [
    'Runs the workspace suite; it does not author test code.',
    'Coverage thresholds are the caller\'s policy, not this adapter\'s default.',
  ],
};

interface VitestNodeModule {
  startVitest: (
    mode: string,
    filters: string[],
    options?: Record<string, unknown>,
  ) => Promise<VitestInstance | undefined>;
}

interface VitestTestModule {
  /** A TestCollection object, not a callable and not an array. */
  children?: { allTests: () => Iterable<{ ok: () => boolean }> };
  ok?: () => boolean;
  state?: () => { getCountOfFailedTests?: () => number };
}

interface VitestInstance {
  state: {
    getTestModules: () => VitestTestModule[];
    getFiles?: () => VitestTestModule[];
  };
  close?: () => Promise<void>;
}

export interface VitestAdapterOptions {
  /** Test file globs relative to the workspace root. */
  include?: readonly string[];
  /** Optional reporter name; the default reporter is used when omitted. */
  reporter?: string;
  loadModule?: () => Promise<VitestNodeModule>;
}

/** CORTEX testing SDK: runs the workspace test suite with the real runner. */
export class VitestAdapter implements CortexSdkAdapter {
  readonly descriptor = VITEST_DESCRIPTOR;
  private readonly include: readonly string[];
  private readonly reporter?: string;
  private readonly loader: () => Promise<VitestNodeModule>;

  constructor(options: VitestAdapterOptions = {}) {
    this.include = options.include ?? [];
    if (this.include.some((entry) => path.isAbsolute(entry) || entry.includes('..'))) {
      throw new CortexValidationError('include patterns must be relative and must not traverse upward.');
    }
    this.reporter = options.reporter;
    this.loader = options.loadModule ?? (() => loadSdk<VitestNodeModule>('vitest/node', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('vitest/node');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'vitest task');
    const root = taskWorkspaceRoot(task);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'Vitest forks test workers');

    // Only ever point Vitest at paths inside the workspace, even if the caller
    // supplied its own include list.
    const filters = this.include.length > 0
      ? this.include.map((entry) => resolveInsideWorkspace(task, entry, 'include entry'))
      : listWorkspaceFiles(root, { extensions: ['.test.ts', '.test.tsx', '.spec.ts'], maxFiles: 100 })
          .map((entry) => path.join(root, entry));

    if (filters.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'No test files were found in the workspace.',
      });
    }

    let module: VitestNodeModule;
    try {
      module = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const options: Record<string, unknown> = {
      root,
      dir: root,
      run: true,
      watch: false,
      coverage: { enabled: false },
      passWithNoTests: false,
      // This adapter reads structured results from `vitest.state`, so the
      // default reporter's console output is pure noise for the caller.
      reporters: [this.reporter ?? SILENT_REPORTER],
    };

    const vitest = await module.startVitest('test', filters, options);
    if (!vitest) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'Vitest did not start.',
      });
    }

    try {
      const modules = vitest.state.getTestModules();
      let passed = 0;
      let failed = 0;
      for (const testModule of modules) {
        // `children` is a TestCollection whose allTests() walks this module and
        // every nested suite. It is not callable and not an array.
        const collection = testModule.children;
        if (!collection || typeof collection.allTests !== 'function') continue;
        for (const test of collection.allTests()) {
          if (test.ok()) passed += 1;
          else failed += 1;
        }
      }

      const evidence = {
        testModules: modules.length,
        passed,
        failed,
        filters: filters.map((filter) => safeSnippet(path.relative(root, filter), 200)),
      };
      if (failed > 0 || modules.length === 0) {
        return failureResult({
          task,
          sdkId: this.descriptor.id,
          startedAt,
          evidence,
          error: `${failed} test(s) failed across ${modules.length} module(s).`,
        });
      }
      return successResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        artifacts: [{ name: 'test-run', kind: 'report', summary: `${passed} tests passed` }],
        evidence,
      });
    } finally {
      await vitest.close?.();
    }
  }
}

/** True when a Vitest config exists in the workspace; informational only. */
export function hasVitestConfig(root: string): boolean {
  return ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vite.config.ts']
    .some((file) => existsSync(path.join(root, file)));
}
