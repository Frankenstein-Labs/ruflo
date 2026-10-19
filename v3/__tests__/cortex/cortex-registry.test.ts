import { describe, expect, it, vi } from 'vitest';
import {
  CortexPolicy,
  CortexSdkRegistry,
  CortexValidationError,
  createDefaultRegistry,
  probeRegistry,
  statusRank,
  CORTEX_CAPABILITIES,
  type CortexAdapterContext,
  type CortexSdkAdapter,
  type CortexSdkDescriptor,
  type CortexSdkTask,
  type CortexTaskResult,
} from '../../src/cortex';

function makeTask(overrides: Partial<CortexSdkTask> = {}): CortexSdkTask {
  return {
    taskId: 'task-1',
    capability: 'testing',
    instruction: 'Run the suite',
    workspace: { hostRoot: '/tmp/cortex-workspace' },
    acceptanceCriteria: ['All tests pass'],
    ...overrides,
  };
}

function makeContext(overrides: Partial<CortexAdapterContext> = {}): CortexAdapterContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 30_000,
    log: vi.fn(),
    authorize: () => ({ allowed: true, reason: 'test' }),
    ...overrides,
  };
}

function makeDescriptor(overrides: Partial<CortexSdkDescriptor> = {}): CortexSdkDescriptor {
  return {
    id: 'fake-sdk',
    capability: 'testing',
    name: 'Fake SDK',
    packageName: 'fake-sdk',
    version: '1.0.0',
    license: 'MIT',
    source: 'https://example.com/fake-sdk',
    registry: 'npm',
    dependencyType: 'optionalDependency',
    capabilities: ['do a thing'],
    status: 'integrated',
    limitations: [],
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<CortexSdkAdapter> = {}): CortexSdkAdapter {
  return {
    descriptor: makeDescriptor(),
    isAvailable: vi.fn(async () => true),
    run: vi.fn(async (task: CortexSdkTask): Promise<CortexTaskResult> => ({
      taskId: task.taskId,
      sdkId: 'fake-sdk',
      capability: task.capability,
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifacts: [],
      evidence: {},
    })),
    ...overrides,
  };
}

describe('CortexSdkRegistry', () => {
  it('registers one adapter per capability and rejects a duplicate slot', () => {
    const registry = new CortexSdkRegistry();
    registry.register(makeAdapter());
    expect(registry.forCapability('testing').descriptor.id).toBe('fake-sdk');

    expect(() => registry.register(makeAdapter({
      descriptor: makeDescriptor({ id: 'other-sdk' }),
    }))).toThrow(/already has SDK/);
  });

  it('rejects a descriptor whose source is not an https URL', () => {
    const registry = new CortexSdkRegistry();
    expect(() => registry.register(makeAdapter({
      descriptor: makeDescriptor({ source: 'http://insecure.example.com/pkg' }),
    }))).toThrow(/https URL/);
  });

  it('rejects a descriptor that claims an install without a pinned version', () => {
    const registry = new CortexSdkRegistry();
    expect(() => registry.register(makeAdapter({
      descriptor: makeDescriptor({ status: 'installed', version: 'unknown' }),
    }))).toThrow(/concrete pinned version/);
  });

  it('reports capabilities that have no SDK instead of pretending coverage', () => {
    const registry = new CortexSdkRegistry();
    registry.register(makeAdapter());
    const missing = registry.missingCapabilities(CORTEX_CAPABILITIES);
    expect(missing).toContain('security');
    expect(missing).not.toContain('testing');
  });
});

describe('createDefaultRegistry', () => {
  it('registers exactly the ten mission SDKs, one per capability', () => {
    const registry = createDefaultRegistry();
    const descriptors = registry.descriptors();
    expect(descriptors).toHaveLength(10);
    const capabilities = descriptors.map((descriptor) => descriptor.capability);
    expect(new Set(capabilities).size).toBe(10);
    expect(capabilities.sort()).toEqual([...CORTEX_CAPABILITIES].sort());
  });

  it('never claims production-ready while limitations are still listed', () => {
    for (const descriptor of createDefaultRegistry().descriptors()) {
      if (descriptor.status === 'production-ready') {
        expect(descriptor.limitations).toHaveLength(0);
      }
      // Honesty guard: nothing in this repository is claimed as live-verified
      // without the evidence file that documents the live run.
      expect(statusRank(descriptor.status)).toBeLessThanOrEqual(statusRank('live-tested'));
    }
  });

  it('probes availability without one broken SDK taking the others down', async () => {
    const registry = new CortexSdkRegistry();
    registry.register(makeAdapter({
      isAvailable: vi.fn(async () => { throw new Error('probe exploded'); }),
    }));
    registry.register(makeAdapter({
      descriptor: makeDescriptor({ id: 'healthy-sdk', capability: 'security' }),
      isAvailable: vi.fn(async () => true),
    }));

    const availability = await probeRegistry(registry);
    const broken = availability.find((entry) => entry.sdkId === 'fake-sdk');
    const healthy = availability.find((entry) => entry.sdkId === 'healthy-sdk');
    expect(broken?.available).toBe(false);
    expect(broken?.reason).toMatch(/probe exploded/);
    expect(healthy?.available).toBe(true);
  });
});

describe('CortexPolicy', () => {
  it('fails closed when no rule grants an operation', () => {
    const policy = new CortexPolicy();
    const decision = policy.authorize({ sdkId: 'fake-sdk', operation: 'network', detail: 'https://example.com' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/fails closed/);
  });

  it('refuses to be constructed with a permissive default', () => {
    expect(() => new CortexPolicy({ defaultAllowed: true })).toThrow(/fail closed/);
  });

  it('requires process-capable SDKs to be on the allowlist', () => {
    const policy = new CortexPolicy({
      rules: [{ sdkId: 'runner', operation: 'spawn-process', allowed: true }],
      processAllowlist: ['runner'],
    });
    expect(policy.authorize({ sdkId: 'runner', operation: 'spawn-process', detail: 'vitest' }).allowed).toBe(true);
    expect(policy.authorize({ sdkId: 'other', operation: 'spawn-process', detail: 'vitest' }).allowed).toBe(false);
  });

  it('keeps an audit trail of every decision', () => {
    const policy = new CortexPolicy();
    policy.authorize({ sdkId: 'a', operation: 'network', detail: 'x' });
    policy.authorize({ sdkId: 'b', operation: 'git-write', detail: 'y' });
    expect(policy.auditTrail()).toHaveLength(2);
  });
});

describe('adapter contract', () => {
  it('produces results whose taskId and sdkId match the descriptor', async () => {
    const adapter = makeAdapter();
    const task = makeTask();
    const result = await adapter.run(task, makeContext());
    expect(result.taskId).toBe(task.taskId);
    expect(result.sdkId).toBe(adapter.descriptor.id);
  });

  it('throws a validation error for a relative workspace root', async () => {
    const { assertUsableRoot } = await import('../../src/cortex');
    expect(() => assertUsableRoot('relative/path')).toThrow(CortexValidationError);
    expect(() => assertUsableRoot('/')).toThrow(/filesystem root/);
  });
});
