import { describe, expect, it, vi } from 'vitest';
import {
  OpenHandsAgentBackend,
  OpenHandsBackendError,
  openHandsConfigFromEnv,
} from '../../src/openhands/OpenHandsAgentBackend';

const task = {
  taskId: 'task-001',
  instruction: 'Add a short project summary to README.md.',
  workingDirectory: '/workspace/project',
  acceptanceCriteria: ['README.md contains a project summary'],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenHandsAgentBackend', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(() => new OpenHandsAgentBackend({
      baseUrl: 'http://localhost:8000',
      enabled: false,
      agent: { llm: {} },
      allowedWorkspaceRoot: '/workspace',
    })).toThrow(/disabled/i);
  });

  it('requires HTTPS and an API key for remote Agent Servers', () => {
    expect(() => new OpenHandsAgentBackend({
      baseUrl: 'http://agent.example.com',
      enabled: true,
      agent: { llm: {} },
      allowedWorkspaceRoot: '/workspace',
    })).toThrow(/HTTPS/i);

    expect(() => new OpenHandsAgentBackend({
      baseUrl: 'https://agent.example.com',
      enabled: true,
      agent: { llm: {} },
      allowedWorkspaceRoot: '/workspace',
    })).toThrow(/API_KEY/i);
  });

  it('creates and starts a conversation and returns a truthful submitted handle', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ id: 'conversation-123' }))
      .mockResolvedValueOnce(response({ success: true }));

    const backend = new OpenHandsAgentBackend({
      baseUrl: 'http://localhost:8000',
      enabled: true,
      agent: { llm: { model: 'test-model' } },
      allowedWorkspaceRoot: '/workspace',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const handle = await backend.submit(task);

    expect(handle).toEqual({
      provider: 'openhands',
      taskId: 'task-001',
      conversationId: 'conversation-123',
      status: 'submitted',
      serverUrl: 'http://localhost:8000',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://localhost:8000/api/conversations');
    expect(String(fetchImpl.mock.calls[1][0])).toBe('http://localhost:8000/api/conversations/conversation-123/run');
    const payload = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(payload.workspace).toEqual({ type: 'local', working_dir: '/workspace/project' });
    expect(payload.initial_message.content[0].text).toContain('README.md contains a project summary');
  });

  it('rejects path traversal and does not send a request', async () => {
    const fetchImpl = vi.fn();
    const backend = new OpenHandsAgentBackend({
      baseUrl: 'http://localhost:8000',
      enabled: true,
      agent: { llm: {} },
      allowedWorkspaceRoot: '/workspace',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(backend.submit({ ...task, workingDirectory: '/workspace/../secrets' }))
      .rejects.toThrow(/path traversal/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts response bodies from HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('SECRET_PROVIDER_DETAIL', { status: 500 }),
    );
    const backend = new OpenHandsAgentBackend({
      baseUrl: 'http://localhost:8000',
      enabled: true,
      agent: { llm: {} },
      allowedWorkspaceRoot: '/workspace',
      fetchImpl: fetchImpl as typeof fetch,
    });

    let error: unknown;
    try {
      await backend.submit(task);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpenHandsBackendError);
    expect(String(error)).not.toContain('SECRET_PROVIDER_DETAIL');
  });

  it('maps environment configuration without enabling the backend implicitly', () => {
    const config = openHandsConfigFromEnv({ llm: { model: 'test-model' } }, {
      CORTEX_OPENHANDS_BASE_URL: 'http://localhost:8000',
    });
    expect(config.enabled).toBe(false);
    expect(config.agent).toEqual({ llm: { model: 'test-model' } });
    expect(config.allowedWorkspaceRoot).toBe('');
  });
});
