import { describe, expect, it, vi } from 'vitest';
import {
  CortexLogger,
  CortexOrchestrator,
  CortexSdkRegistry,
  CortexSdkUnavailableError,
  CortexValidationError,
  REDACTED,
  allowlistPolicy,
  authorize,
  assertInsideRoot,
  assertSafeGitRef,
  assertSafeSegment,
  assertNoDependencyCycles,
  redactText,
  redactValue,
  safeErrorMessage,
  safeExec,
  type CortexAdapterContext,
  type CortexSdkAdapter,
  type CortexSdkDescriptor,
  type CortexSdkTask,
  type CortexTaskResult,
} from '../../src/cortex';

const WORKSPACE = '/tmp/cortex-orchestrator-workspace';

function descriptor(overrides: Partial<CortexSdkDescriptor> = {}): CortexSdkDescriptor {
  return {
    id: 'runner',
    capability: 'testing',
    name: 'Runner',
    packageName: 'runner',
    version: '1.0.0',
    license: 'MIT',
    source: 'https://example.com/runner',
    registry: 'npm',
    dependencyType: 'optionalDependency',
    capabilities: ['run'],
    status: 'integrated',
    limitations: [],
    ...overrides,
  };
}

function adapter(overrides: Partial<CortexSdkAdapter> = {}): CortexSdkAdapter {
  return {
    descriptor: descriptor(),
    isAvailable: async () => true,
    run: async (task: CortexSdkTask): Promise<CortexTaskResult> => ({
      taskId: task.taskId,
      sdkId: 'runner',
      capability: task.capability,
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifacts: [],
      evidence: {},
    }),
    ...overrides,
  };
}

function request(taskId: string, capability: CortexSdkTask['capability'] = 'testing', extra: Record<string, unknown> = {}) {
  return {
    taskId,
    capability,
    instruction: `Do ${taskId}`,
    workspace: { hostRoot: WORKSPACE },
    acceptanceCriteria: ['criterion'],
    ...extra,
  };
}

function orchestratorWith(sdk: CortexSdkAdapter, options: Record<string, unknown> = {}) {
  const registry = new CortexSdkRegistry();
  registry.register(sdk);
  return new CortexOrchestrator({
    registry,
    logger: new CortexLogger({ minLevel: 'error', sink: () => {} }),
    defaultTimeoutMs: 5_000,
    ...options,
  });
}

describe('CortexOrchestrator', () => {
  it('runs a task through the registry and records provenance', async () => {
    const orchestrator = orchestratorWith(adapter());
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('succeeded');
    expect(records[0].sdkId).toBe('runner');
    expect(orchestrator.sdkProvenance()).toEqual([
      { taskId: 't1', sdkId: 'runner', capability: 'testing', state: 'succeeded' },
    ]);
  });

  it('marks a task unavailable when the SDK reports itself missing', async () => {
    const orchestrator = orchestratorWith(adapter({ isAvailable: async () => false }));
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('unavailable');
    expect(records[0].error).toMatch(/unavailable/);
  });

  it('turns a thrown CortexSdkUnavailableError into an unavailable state', async () => {
    const orchestrator = orchestratorWith(adapter({
      run: async () => { throw new CortexSdkUnavailableError('runner', 'package not installed'); },
    }));
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('unavailable');
  });

  it('fails a task when the adapter returns a result for a different task', async () => {
    const orchestrator = orchestratorWith(adapter({
      run: async (task) => ({
        taskId: 'some-other-task',
        sdkId: 'runner',
        capability: task.capability,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        artifacts: [],
        evidence: {},
      }),
    }));
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('failed');
    expect(records[0].error).toMatch(/wrong taskId/);
  });

  it('fails a task whose adapter claims an unknown status', async () => {
    const orchestrator = orchestratorWith(adapter({
      run: async (task) => ({
        taskId: task.taskId,
        sdkId: 'runner',
        capability: task.capability,
        status: 'definitely-fine' as never,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        artifacts: [],
        evidence: {},
      }),
    }));
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('failed');
    expect(records[0].error).toMatch(/unknown status/);
  });

  it('honours dependencies and skips tasks whose dependency failed', async () => {
    const registry = new CortexSdkRegistry();
    registry.register(adapter({
      descriptor: descriptor({ id: 'a', capability: 'testing' }),
      run: async () => { throw new Error('boom'); },
    }));
    registry.register(adapter({ descriptor: descriptor({ id: 'b', capability: 'security' }) }));
    const orchestrator = new CortexOrchestrator({ registry, defaultTimeoutMs: 5_000 });

    const records = await orchestrator.runBatch(
      [request('first', 'testing'), request('second', 'security')],
      { dependsOn: { second: ['first'] } },
    );
    expect(records.find((r) => r.taskId === 'first')?.state).toBe('failed');
    const second = records.find((r) => r.taskId === 'second');
    expect(second?.state).toBe('skipped');
    expect(second?.error).toMatch(/dependency failed/);
  });

  it('rejects a dependency cycle before running anything', () => {
    expect(() => assertNoDependencyCycles({ a: ['b'], b: ['a'] })).toThrow(/cycle/);
  });

  it('rejects a dependency on an unknown task', async () => {
    const orchestrator = orchestratorWith(adapter());
    await expect(
      orchestrator.runBatch([request('t1')], { dependsOn: { t1: ['ghost'] } }),
    ).rejects.toThrow(/unknown task/);
  });

  it('stops a task that exceeds its timeout', async () => {
    const orchestrator = orchestratorWith(adapter({
      run: async () => new Promise(() => { /* never resolves */ }),
    }));
    const records = await orchestrator.runBatch(
      [request('slow', 'testing', { timeoutMs: 1_000 })],
      { maxConcurrency: 1 },
    );
    expect(records[0].state).toBe('timed-out');
  }, 15_000);

  it('reports a cancelled task when the batch signal fires', async () => {
    const controller = new AbortController();
    let observedAbort = false;
    const orchestrator = orchestratorWith(adapter({
      run: async (_task, ctx: CortexAdapterContext) => {
        // Observe the signal, then keep running: the orchestrator must not wait
        // for an adapter that ignores its cancellation.
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true });
          setTimeout(resolve, 5_000);
        });
        throw new Error('adapter stopped after abort');
      },
    }));
    const batch = orchestrator.runBatch([request('t1')], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const records = await batch;
    expect(observedAbort).toBe(true);
    expect(records[0].state).toBe('cancelled');
  });

  it('refuses a batch with duplicate task ids', async () => {
    const orchestrator = orchestratorWith(adapter());
    await expect(orchestrator.runBatch([request('dup'), request('dup')])).rejects.toThrow(/unique taskId/);
  });

  it('rejects a task with no acceptance criteria', () => {
    const orchestrator = orchestratorWith(adapter());
    expect(() => orchestrator.enqueue({ ...request('t1'), acceptanceCriteria: [] })).toThrow(CortexValidationError);
  });

  it('runs independent tasks up to the concurrency limit', async () => {
    let concurrent = 0;
    let peak = 0;
    const orchestrator = orchestratorWith(adapter({
      run: async (task) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        return {
          taskId: task.taskId,
          sdkId: 'runner',
          capability: task.capability,
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          artifacts: [],
          evidence: {},
        };
      },
    }), { maxConcurrency: 2 });

    const records = await orchestrator.runBatch(
      [request('a'), request('b'), request('c'), request('d')],
      { maxConcurrency: 2 },
    );
    expect(records.every((record) => record.state === 'succeeded')).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('does not retry a task that was denied by policy', async () => {
    const registry = new CortexSdkRegistry();
    registry.register(adapter({
      // A real adapter asks the policy layer before a sensitive operation; the
      // orchestrator records the denial and never retries it.
      run: async (task, ctx) => {
        authorize(ctx, 'runner', 'network', 'https://example.com/collect');
        return {
          taskId: task.taskId,
          sdkId: 'runner',
          capability: task.capability,
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          artifacts: [],
          evidence: {},
        };
      },
    }));
    const orchestrator = new CortexOrchestrator({
      registry,
      policy: allowlistPolicy([{ sdkId: 'runner', operations: ['spawn-process'] }]),
      defaultTimeoutMs: 5_000,
    });
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('denied');
    expect(records[0].error).toMatch(/denied network/);
    const resumed = await orchestrator.resume('t1');
    expect(resumed.state).toBe('denied');
    expect(resumed.attempts).toBe(1);
  });

  it('allows a sensitive operation that the policy explicitly grants', async () => {
    const registry = new CortexSdkRegistry();
    registry.register(adapter({
      run: async (task, ctx) => {
        authorize(ctx, 'runner', 'network', 'https://example.com/collect');
        return {
          taskId: task.taskId,
          sdkId: 'runner',
          capability: task.capability,
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          artifacts: [],
          evidence: {},
        };
      },
    }));
    const orchestrator = new CortexOrchestrator({
      registry,
      policy: allowlistPolicy([{ sdkId: 'runner', operations: ['network'] }]),
      defaultTimeoutMs: 5_000,
    });
    const records = await orchestrator.runBatch([request('t1')]);
    expect(records[0].state).toBe('succeeded');
  });
});

describe('security primitives', () => {
  it('redacts known token shapes', () => {
    const text = 'token sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwx';
    const redacted = redactText(text);
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
    expect(redacted).toContain(REDACTED);
  });

  it('redacts secret-looking keys in structured values', () => {
    const redacted = redactValue({
      API_KEY: 'super-secret-value',
      nested: { dbPassword: 'hunter2', safe: 'visible' },
    }) as Record<string, unknown>;
    expect(redacted.API_KEY).toBe(REDACTED);
    expect((redacted.nested as Record<string, unknown>).dbPassword).toBe(REDACTED);
    expect((redacted.nested as Record<string, unknown>).safe).toBe('visible');
  });

  it('reduces a multi-line error to one redacted line', () => {
    const message = safeErrorMessage(new Error('line one\nAuthorization: Bearer abcdefghijklmnopqrst\n'));
    expect(message).not.toContain('\n');
    expect(message).not.toContain('abcdefghijklmnopqrst');
  });

  it('rejects traversal and option-like segments', () => {
    expect(() => assertSafeSegment('../escape', 'taskId')).toThrow(CortexValidationError);
    expect(() => assertSafeSegment('-flag', 'taskId')).toThrow(/dash/);
    expect(() => assertSafeSegment('..', 'taskId')).toThrow(CortexValidationError);
    expect(assertSafeSegment('task-1_ok', 'taskId')).toBe('task-1_ok');
  });

  it('rejects git refs that could be read as options or escapes', () => {
    expect(() => assertSafeGitRef('--upload-pack=/bin/sh')).toThrow(CortexValidationError);
    expect(() => assertSafeGitRef('feature/../..')).toThrow(/not valid in a Git ref/);
    expect(assertSafeGitRef('cortex/task-1')).toBe('cortex/task-1');
  });

  it('proves a path stays inside its root', () => {
    expect(assertInsideRoot('/tmp/root', '/tmp/root/a/b.txt', 'target')).toBe('/tmp/root/a/b.txt');
    expect(() => assertInsideRoot('/tmp/root', '/tmp/root', 'target')).toThrow(/not the root itself/);
    expect(() => assertInsideRoot('/tmp/root', '/tmp/other/a.txt', 'target')).toThrow(/outside the configured/);
  });

  it('runs a command without a shell and reports its exit code', async () => {
    const result = await safeExec({ command: 'git', args: ['--version'], cwd: process.cwd(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/git version/);
  });

  it('does not let a shell metacharacter become a command', async () => {
    const result = await safeExec({
      command: 'echo',
      args: ['$(whoami)'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    // The literal text is echoed; it is never executed.
    expect(result.stdout.trim()).toBe('$(whoami)');
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const result = await safeExec({
      command: 'git',
      args: ['rev-parse', '--verify', 'refs/heads/definitely-not-a-branch'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it('never leaks a secret through the logger', () => {
    const lines: string[] = [];
    const logger = new CortexLogger({ minLevel: 'debug', sink: (line) => lines.push(line) });
    logger.log({
      level: 'info',
      sdkId: 'runner',
      message: 'probe',
      data: { CORTEX_OPENHANDS_API_KEY: 'sk-abcdefghijklmnopqrstuvwx' },
    });
    expect(lines.join('\n')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(lines.join('\n')).toContain(REDACTED);
  });

  it('caps retained log entries', () => {
    const logger = new CortexLogger({ minLevel: 'debug', sink: () => {}, maxRetained: 3 });
    for (let index = 0; index < 10; index += 1) {
      logger.log({ level: 'info', sdkId: 'runner', message: `event ${index}` });
    }
    expect(logger.history()).toHaveLength(3);
  });
});
