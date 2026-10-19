import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CortexLogger,
  type CortexAdapterContext,
  type CortexSdkTask,
} from '../../src/cortex';
import { AutocannonAdapter } from '../../src/cortex/adapters/autocannonAdapter';
import { CycloneDxAdapter } from '../../src/cortex/adapters/cyclonedxAdapter';
import { DrizzleAdapter } from '../../src/cortex/adapters/drizzleAdapter';
import { FastifyAdapter } from '../../src/cortex/adapters/fastifyAdapter';
import { LangGraphAdapter, extractObjectives } from '../../src/cortex/adapters/langgraphAdapter';
import { OctokitAdapter } from '../../src/cortex/adapters/octokitAdapter';
import { OpenHandsAdapter } from '../../src/cortex/adapters/openhandsAdapter';
import { TypeDocAdapter } from '../../src/cortex/adapters/typedocAdapter';
import { ViteAdapter } from '../../src/cortex/adapters/viteAdapter';
import { VitestAdapter } from '../../src/cortex/adapters/vitestAdapter';

const tempRoots: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-adapter-'));
  tempRoots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function context(overrides: Partial<CortexAdapterContext> = {}): CortexAdapterContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60_000,
    log: () => {},
    authorize: () => ({ allowed: true, reason: 'test' }),
    ...overrides,
  };
}

function task(hostRoot: string, overrides: Partial<CortexSdkTask> = {}): CortexSdkTask {
  return {
    taskId: 'adapter-task',
    capability: 'testing',
    instruction: 'Do the work',
    workspace: { hostRoot },
    acceptanceCriteria: ['it works'],
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe('LangGraphAdapter (real SDK)', () => {
  it('reports itself available when the package is installed', async () => {
    expect(await new LangGraphAdapter().isAvailable()).toBe(true);
  });

  it('produces an ordered plan through a real state graph', async () => {
    const root = await workspace();
    const adapter = new LangGraphAdapter();
    const result = await adapter.run(
      task(root, {
        capability: 'planning',
        instruction: 'Design the API\nImplement the handler\nWrite the tests',
      }),
      context(),
    );

    expect(result.status).toBe('succeeded');
    expect(result.sdkId).toBe('langgraph');
    expect(result.evidence.steps).toBe(3);
    expect(result.evidence.plan).toEqual([
      '1. Design the API',
      '2. Implement the handler',
      '3. Write the tests',
    ]);
  });

  it('fails when the mission has nothing to decompose', async () => {
    const root = await workspace();
    const result = await new LangGraphAdapter().run(
      task(root, { capability: 'planning', instruction: '   \n  \n' }),
      context(),
    );
    expect(result.status).toBe('failed');
  });

  it('splits a single-line mission on sentence boundaries', () => {
    expect(extractObjectives('First do this. Then do that. Finally ship it.', 10)).toHaveLength(3);
  });
});

describe('ViteAdapter (real SDK)', () => {
  it('builds a real frontend workspace and reports emitted files', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><h1>cortex</h1></body></html>\n');
    await fs.writeFile(path.join(root, 'main.js'), 'document.title = "cortex";\n');

    const adapter = new ViteAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    const result = await adapter.run(task(root, { capability: 'frontend' }), context());

    expect(result.status).toBe('succeeded');
    expect(result.evidence.emitted).toBeGreaterThan(0);
    expect(result.evidence.hasHtml).toBe(true);
    await expect(fs.access(path.join(root, 'dist', 'index.html'))).resolves.toBeUndefined();
  }, 120_000);

  it('refuses an outDir that escapes the workspace', () => {
    expect(() => new ViteAdapter({ outDir: '../escape' })).toThrow(/relative directory/);
  });
});

describe('FastifyAdapter (real SDK)', () => {
  it('exercises routes through the real inject() path', async () => {
    const root = await workspace();
    const adapter = new FastifyAdapter({ routes: [{ method: 'GET', url: '/health' }] });
    expect(await adapter.isAvailable()).toBe(true);

    const result = await adapter.run(task(root, { capability: 'backend' }), context());
    expect(result.status).toBe('succeeded');
    expect(result.evidence.probes).toEqual([{ method: 'GET', url: '/health', statusCode: 200 }]);
  });
});

describe('DrizzleAdapter (real SDK)', () => {
  it('renders CREATE TABLE DDL from a real schema definition', async () => {
    const root = await workspace();
    const adapter = new DrizzleAdapter();
    expect(await adapter.isAvailable()).toBe(true);

    const result = await adapter.run(
      task(root, {
        capability: 'data',
        options: {
          tables: [
            {
              name: 'cortex_tasks',
              columns: [
                { name: 'id', type: 'serial', primaryKey: true },
                { name: 'name', type: 'text', notNull: true },
                { name: 'created_at', type: 'timestamp' },
              ],
            },
          ],
        },
      }),
      context(),
    );

    expect(result.status).toBe('succeeded');
    expect(result.evidence.ddl?.[0]).toMatch(/^CREATE TABLE cortex_tasks \(/);
    expect(result.evidence.ddl?.[0]).toMatch(/id serial/);
    expect(result.evidence.tables).toEqual([{ name: 'cortex_tasks', columnCount: 3 }]);
  });

  it('fails when no table specification is available', async () => {
    const root = await workspace();
    const result = await new DrizzleAdapter().run(task(root, { capability: 'data' }), context());
    expect(result.status).toBe('failed');
  });
});

describe('VitestAdapter (real SDK)', () => {
  it('runs a real suite and counts passed tests', async () => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'specs'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'specs', 'sample.test.ts'),
      'import { expect, it } from "vitest";\nit("adds", () => { expect(1 + 1).toBe(2); });\nit("subtracts", () => { expect(2 - 1).toBe(1); });\n',
    );

    const adapter = new VitestAdapter({ include: ['specs'] });
    expect(await adapter.isAvailable()).toBe(true);
    const result = await adapter.run(task(root, { capability: 'testing' }), context());

    expect(result.status).toBe('succeeded');
    expect(result.evidence.passed).toBe(2);
    expect(result.evidence.failed).toBe(0);
  }, 180_000);

  it('fails the task when a test fails, instead of reporting success', async () => {
    const root = await workspace();
    await fs.writeFile(
      path.join(root, 'broken.test.ts'),
      'import { expect, it } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n',
    );

    const result = await new VitestAdapter({ include: ['broken.test.ts'] })
      .run(task(root, { capability: 'testing' }), context());
    expect(result.status).toBe('failed');
    expect(result.evidence.failed).toBe(1);
  }, 180_000);

  it('rejects an include pattern that escapes the workspace', () => {
    expect(() => new VitestAdapter({ include: ['../outside'] })).toThrow(/traverse/);
  });
});

describe('CycloneDxAdapter (real SDK)', () => {
  it('serializes a real CycloneDX 1.6 BOM', async () => {
    const root = await workspace();
    const adapter = new CycloneDxAdapter({
      productName: 'cortex-agent-os',
      productVersion: '1.0.0',
      components: [
        { name: 'fastify', version: '5.12.7', license: 'MIT' },
        { name: 'drizzle-orm', version: '0.45.4', license: 'Apache-2.0' },
      ],
    });
    expect(await adapter.isAvailable()).toBe(true);

    const result = await adapter.run(task(root, { capability: 'security' }), context());
    expect(result.status).toBe('succeeded');
    expect(result.evidence.bomFormat).toBe('CycloneDX');
    expect(result.evidence.specVersion).toBe('1.6');
    expect(result.evidence.components).toHaveLength(2);
    expect((result.evidence.components as Array<{ hasLicense: boolean }>)[0].hasLicense).toBe(true);
  });

  it('fails when no components are supplied', async () => {
    const root = await workspace();
    const result = await new CycloneDxAdapter().run(task(root, { capability: 'security' }), context());
    expect(result.status).toBe('failed');
  });
});

describe('TypeDocAdapter (real SDK)', () => {
  it('reflects real exported symbols from a TypeScript file', async () => {
    const root = await workspace();
    await fs.writeFile(
      path.join(root, 'api.ts'),
      'export interface Widget { id: string }\nexport function makeWidget(id: string): Widget { return { id }; }\n',
    );

    const adapter = new TypeDocAdapter({ entryPoints: ['api.ts'] });
    expect(await adapter.isAvailable()).toBe(true);
    const result = await adapter.run(task(root, { capability: 'documentation' }), context());

    expect(result.status).toBe('succeeded');
    expect(result.evidence.symbols?.length).toBeGreaterThan(0);
    expect((result.evidence.symbols as string[]).join(' ')).toMatch(/makeWidget/);
  }, 180_000);

  it('fails when the workspace has no TypeScript entry points', async () => {
    const root = await workspace();
    const result = await new TypeDocAdapter().run(task(root, { capability: 'documentation' }), context());
    expect(result.status).toBe('failed');
  });
});

describe('AutocannonAdapter (real SDK)', () => {
  it('refuses to load-test a non-loopback target', async () => {
    const root = await workspace();
    const adapter = new AutocannonAdapter();
    await expect(
      adapter.run(task(root, { capability: 'performance', options: { url: 'https://example.com' } }), context()),
    ).rejects.toThrow(/loopback/);
  });

  it('refuses a non-http scheme even on loopback', async () => {
    const root = await workspace();
    await expect(
      new AutocannonAdapter().run(
        task(root, { capability: 'performance', options: { url: 'file://127.0.0.1/etc/passwd' } }),
        context(),
      ),
    ).rejects.toThrow(/only http/);
  });

  it('measures a real loopback server and reports throughput', async () => {
    const root = await workspace();
    const fastifyModule = await import('fastify');
    const server = fastifyModule.default({ logger: false });
    server.get('/health', () => ({ ok: true }));
    const address = await server.listen({ port: 0, host: '127.0.0.1' });

    try {
      const adapter = new AutocannonAdapter();
      expect(await adapter.isAvailable()).toBe(true);
      const result = await adapter.run(
        task(root, {
          capability: 'performance',
          options: { url: `${address}/health`, durationSeconds: 2, connections: 4, minRequestsPerSecond: 1 },
        }),
        context(),
      );
      expect(result.status).toBe('succeeded');
      expect(result.evidence.requestsTotal as number).toBeGreaterThan(0);
      expect(result.evidence.errors).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('OpenHandsAdapter (REST contract, mocked transport)', () => {
  const agent = { kind: 'OpenHandsAgent', llm: { model: 'openai/gpt-4o-mini' } };

  it('is unavailable unless explicitly enabled and fully configured', async () => {
    expect(await new OpenHandsAdapter({ env: {} }).isAvailable()).toBe(false);
    expect(await new OpenHandsAdapter({
      baseUrl: 'http://localhost:8000',
      agent,
      allowedWorkspaceRoot: '/workspace',
      enabled: false,
      env: {},
    }).isAvailable()).toBe(false);
    expect(await new OpenHandsAdapter({
      baseUrl: 'http://localhost:8000',
      agent,
      allowedWorkspaceRoot: '/workspace',
      enabled: true,
      env: {},
    }).isAvailable()).toBe(true);
  });

  it('rejects a plain-HTTP non-local Agent Server URL', async () => {
    expect(await new OpenHandsAdapter({
      baseUrl: 'http://agent.example.com',
      agent,
      allowedWorkspaceRoot: '/workspace',
      enabled: true,
      env: {},
    }).isAvailable()).toBe(false);
  });

  it('treats a non-finished conversation as a failure, not a success', async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/conversations')) {
        return new Response(JSON.stringify({ id: 'conv-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'conv-1', execution_status: 'error' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const adapter = new OpenHandsAdapter({
      baseUrl: 'http://localhost:8000',
      agent,
      allowedWorkspaceRoot: '/workspace',
      enabled: true,
      env: {},
      pollIntervalMs: 250,
      maxWaitMs: 5_000,
      requestTimeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.run(
      task(root, { capability: 'code-execution', workspace: { hostRoot: root, sandboxRoot: '/workspace' } }),
      context(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/error/);
    expect(result.evidence.conversationId).toBe('conv-1');
  }, 30_000);

  it('accepts a finished conversation and records only safe evidence', async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/conversations')) {
        return new Response(JSON.stringify({ id: 'conv-2' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'conv-2',
          execution_status: 'finished',
          // A transcript that contains a secret must never reach the evidence.
          transcript: 'used key sk-abcdefghijklmnopqrstuvwx to call the model',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const adapter = new OpenHandsAdapter({
      baseUrl: 'http://localhost:8000',
      agent,
      allowedWorkspaceRoot: '/workspace',
      enabled: true,
      env: {},
      pollIntervalMs: 250,
      maxWaitMs: 5_000,
      requestTimeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.run(
      task(root, { capability: 'code-execution', workspace: { hostRoot: root, sandboxRoot: '/workspace' } }),
      context(),
    );
    expect(result.status).toBe('succeeded');
    expect(result.evidence.executionStatus).toBe('finished');
    expect(JSON.stringify(result.evidence)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(JSON.stringify(result.evidence)).not.toContain('transcript');
  }, 30_000);
});

describe('OctokitAdapter (read-only, mocked transport)', () => {
  it('is unavailable without a token', async () => {
    expect(await new OctokitAdapter().isAvailable()).toBe(false);
  });

  it('summarises a pull request without performing any write', async () => {
    const root = await workspace();
    const adapter = new OctokitAdapter({ token: 'test-token' });
    expect(await adapter.isAvailable()).toBe(true);

    const request = vi.fn(async (route: string) => {
      if (route.includes('/files')) {
        return { status: 200, data: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }] };
      }
      return {
        status: 200,
        data: {
          number: 2,
          title: 'CORTEX',
          state: 'open',
          draft: true,
          mergeable: true,
          additions: 3,
          deletions: 1,
          changed_files: 1,
        },
      };
    });
    const adapterWithFake = new OctokitAdapter({
      token: 'test-token',
      owner: 'Frankenstein-Labs',
      repo: 'ruflo',
      loadModule: async () => ({ Octokit: class { request = request; } as never }),
    });
    void adapter;

    const result = await adapterWithFake.run(
      task(root, { capability: 'review', options: { pullNumber: 2 } }),
      context(),
    );
    expect(result.status).toBe('succeeded');
    expect(result.evidence.performedWrites).toBe(false);
    expect((result.evidence.pullRequest as { number: number }).number).toBe(2);
    expect(result.evidence.files).toHaveLength(1);
  });

  it('rejects an unsafe owner or repo identifier', async () => {
    const root = await workspace();
    const result = await new OctokitAdapter({ token: 'test-token' }).run(
      task(root, { capability: 'review', options: { owner: 'a b', repo: 'ruflo', pullNumber: 2 } }),
      context(),
    );
    expect(result.status).toBe('failed');
  });
});

describe('adapter descriptors', () => {
  it('every adapter reports a distinct capability and a pinned version', () => {
    const adapters = [
      new OpenHandsAdapter({ env: {} }),
      new LangGraphAdapter(),
      new ViteAdapter(),
      new FastifyAdapter(),
      new DrizzleAdapter(),
      new VitestAdapter(),
      new CycloneDxAdapter(),
      new TypeDocAdapter(),
      new AutocannonAdapter(),
      new OctokitAdapter(),
    ];
    const capabilities = adapters.map((adapter) => adapter.descriptor.capability);
    expect(new Set(capabilities).size).toBe(10);
    for (const adapter of adapters) {
      expect(adapter.descriptor.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(adapter.descriptor.license).not.toBe('unknown');
      expect(adapter.descriptor.source).toMatch(/^https:\/\//);
      expect(adapter.descriptor.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('does not log secrets from a workspace path or instruction', () => {
    const lines: string[] = [];
    const logger = new CortexLogger({ minLevel: 'debug', sink: (line) => lines.push(line) });
    logger.log({ level: 'info', sdkId: 'vite', message: 'build', data: { token: 'sk-abcdefghijklmnopqrstuvwx' } });
    expect(lines.join('')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });
});
