/**
 * CORTEX adapter for a remote OpenHands Agent Server.
 *
 * This adapter deliberately uses the documented REST contract rather than
 * importing the Python SDK into Ruflo's Node.js process. The Agent Server must
 * be configured separately with an agent profile or an explicit agent spec.
 */
export interface OpenHandsBackendConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  enabled?: boolean;
  /** Agent specification accepted by the configured OpenHands Agent Server. */
  agent: Record<string, unknown>;
  /** Absolute workspace root visible to Agent Server; tasks cannot escape it. */
  allowedWorkspaceRoot: string;
  maxIterations?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenHandsTask {
  taskId: string;
  instruction: string;
  /** Absolute path visible to the Agent Server, not necessarily the Ruflo host. */
  workingDirectory: string;
  acceptanceCriteria?: string[];
  maxIterations?: number;
}

export interface OpenHandsTaskHandle {
  provider: 'openhands';
  taskId: string;
  conversationId: string;
  status: 'submitted';
  serverUrl: string;
}

export interface OpenHandsConversation {
  id: string;
  status?: string;
  execution_status?: string;
  [key: string]: unknown;
}

export class OpenHandsBackendError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'OpenHandsBackendError';
    this.statusCode = statusCode;
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function safeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenHandsBackendError('CORTEX_OPENHANDS_BASE_URL must be a valid URL.');
  }

  const local = isLocalHost(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new OpenHandsBackendError('OpenHands Agent Server must use HTTPS (HTTP is allowed only for localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OpenHandsBackendError('OpenHands base URL must not contain credentials, query parameters, or a fragment.');
  }
  return new URL(url.toString().replace(/\/$/, ''));
}

function normalizePosixPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new OpenHandsBackendError('Workspace path escapes the filesystem root.');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return '/' + parts.join('/');
}

function validateTask(task: OpenHandsTask, allowedWorkspaceRoot: string): void {
  if (!task.taskId.trim()) throw new OpenHandsBackendError('taskId is required.');
  if (!task.instruction.trim()) throw new OpenHandsBackendError('instruction is required.');
  if (task.instruction.length > 30_000) throw new OpenHandsBackendError('instruction exceeds the 30000 character limit.');
  if (!task.workingDirectory.startsWith('/')) {
    throw new OpenHandsBackendError('workingDirectory must be an absolute POSIX path visible to Agent Server.');
  }
  if (task.workingDirectory.split('/').includes('..')) {
    throw new OpenHandsBackendError('workingDirectory must not contain path traversal segments.');
  }
  if (!allowedWorkspaceRoot.startsWith('/') || allowedWorkspaceRoot.split('/').includes('..')) {
    throw new OpenHandsBackendError('allowedWorkspaceRoot must be an absolute POSIX path without traversal segments.');
  }
  const workspace = normalizePosixPath(task.workingDirectory);
  const root = normalizePosixPath(allowedWorkspaceRoot);
  if (workspace !== root && !workspace.startsWith(root.endsWith('/') ? root : root + '/')) {
    throw new OpenHandsBackendError('workingDirectory is outside the configured allowedWorkspaceRoot.');
  }
  if ((task.acceptanceCriteria ?? []).length > 30) {
    throw new OpenHandsBackendError('At most 30 acceptance criteria are allowed.');
  }
  if ((task.acceptanceCriteria ?? []).some((criterion) => !criterion.trim() || criterion.length > 2_000)) {
    throw new OpenHandsBackendError('Acceptance criteria must be non-empty and no longer than 2000 characters each.');
  }
  const iterations = task.maxIterations;
  if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1 || iterations > 500)) {
    throw new OpenHandsBackendError('maxIterations must be an integer between 1 and 500.');
  }
}

/**
 * Submits a bounded task to OpenHands. Submission is not completion: callers
 * must independently poll status, inspect changed files, and run acceptance
 * checks before marking a CORTEX task successful.
 */
export class OpenHandsAgentBackend {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenHandsBackendConfig) {
    if (config.enabled !== true) {
      throw new OpenHandsBackendError('OpenHands backend is disabled. Set CORTEX_OPENHANDS_ENABLED=true to enable it.');
    }
    this.baseUrl = safeBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 15 * 60_000) {
      throw new OpenHandsBackendError('timeoutMs must be between 1000 and 900000.');
    }
    if (!config.agent || typeof config.agent !== 'object' || Array.isArray(config.agent)) {
      throw new OpenHandsBackendError('A valid OpenHands agent specification is required.');
    }
    if (!config.allowedWorkspaceRoot || !config.allowedWorkspaceRoot.startsWith('/') ||
      config.allowedWorkspaceRoot.split('/').includes('..')) {
      throw new OpenHandsBackendError('allowedWorkspaceRoot must be configured as an absolute POSIX path.');
    }
    if (config.maxIterations !== undefined &&
      (!Number.isInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 500)) {
      throw new OpenHandsBackendError('maxIterations must be an integer between 1 and 500.');
    }
    if (!isLocalHost(this.baseUrl.hostname) && !config.apiKey) {
      throw new OpenHandsBackendError('CORTEX_OPENHANDS_API_KEY is required for non-local Agent Server URLs.');
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async submit(task: OpenHandsTask, signal?: AbortSignal): Promise<OpenHandsTaskHandle> {
    validateTask(task, this.config.allowedWorkspaceRoot);
    const criteria = task.acceptanceCriteria?.length
      ? '\n\nAcceptance criteria (CORTEX must verify these independently):\n' +
        task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : '\n\nCORTEX must independently define and run verification before reporting success.';

    const payload = {
      agent: this.config.agent,
      initial_message: {
        role: 'user',
        content: [{ type: 'text', text: `CORTEX task ${task.taskId}:\n${task.instruction}${criteria}` }],
      },
      max_iterations: task.maxIterations ?? this.config.maxIterations ?? 50,
      stuck_detection: true,
      workspace: { type: 'local', working_dir: task.workingDirectory },
      user_id: 'cortex-agent-os',
    };

    const conversation = await this.request<OpenHandsConversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, signal);

    if (!conversation || typeof conversation.id !== 'string' || !conversation.id.trim()) {
      throw new OpenHandsBackendError('OpenHands returned an invalid conversation response.');
    }

    try {
      await this.request(`/api/conversations/${encodeURIComponent(conversation.id)}/run`, {
        method: 'POST',
        body: '{}',
      }, signal);
    } catch (error) {
      // Do not delete or blindly retry a created conversation: the server may
      // have accepted it despite a lost response. Surface the ID for recovery.
      throw new OpenHandsBackendError(
        `Conversation ${conversation.id} was created but could not be started: ${error instanceof Error ? error.message : 'unknown error'}`,
        error instanceof OpenHandsBackendError ? error.statusCode : undefined,
      );
    }

    return {
      provider: 'openhands',
      taskId: task.taskId,
      conversationId: conversation.id,
      status: 'submitted',
      serverUrl: this.baseUrl.origin,
    };
  }

  async getConversation(conversationId: string, signal?: AbortSignal): Promise<OpenHandsConversation> {
    if (!conversationId.trim()) throw new OpenHandsBackendError('conversationId is required.');
    return this.request<OpenHandsConversation>(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'GET' },
      signal,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        // Never include response bodies: they can contain prompts, secrets, or
        // provider diagnostics. Keep only status and endpoint context.
        throw new OpenHandsBackendError(
          `OpenHands Agent Server request failed (${response.status}) at ${path}.`,
          response.status,
        );
      }
      if (!body.trim()) return {} as T;
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new OpenHandsBackendError(`OpenHands Agent Server returned invalid JSON at ${path}.`);
      }
    } catch (error) {
      if (error instanceof OpenHandsBackendError) throw error;
      if (callerSignal?.aborted) throw new OpenHandsBackendError('OpenHands task request was cancelled.');
      if (controller.signal.aborted) throw new OpenHandsBackendError('OpenHands Agent Server request timed out.');
      throw new OpenHandsBackendError('Could not reach OpenHands Agent Server.');
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

export function openHandsConfigFromEnv(
  agent: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): OpenHandsBackendConfig {
  const timeout = Number(env.CORTEX_OPENHANDS_REQUEST_TIMEOUT_MS ?? 60_000);
  return {
    baseUrl: env.CORTEX_OPENHANDS_BASE_URL ?? 'http://localhost:8000',
    apiKey: env.CORTEX_OPENHANDS_API_KEY,
    timeoutMs: timeout,
    enabled: env.CORTEX_OPENHANDS_ENABLED === 'true',
    allowedWorkspaceRoot: env.CORTEX_OPENHANDS_ALLOWED_WORKSPACE_ROOT ?? '',
    agent,
  };
}
