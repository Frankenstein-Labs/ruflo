import {
  CortexCancelledError,
  CortexError,
  CortexSdkUnavailableError,
  CortexTimeoutError,
  CortexValidationError,
} from '../errors';
import { clampNumber, safeErrorMessage, withDeadline } from '../security';
import type {
  CortexAdapterContext,
  CortexCapability,
  CortexSdkTask,
  CortexTaskResult,
  CortexTaskStatus,
} from '../types';
import { CortexLogger } from './logger';
import { CortexPolicy } from './policy';
import { CortexSdkRegistry } from './registry';

/** Lifecycle of one orchestrated task, exposed to the UI. */
export type CortexRunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unavailable'
  | 'denied'
  | 'skipped';

export interface CortexRunRecord {
  readonly taskId: string;
  readonly capability: CortexCapability;
  readonly sdkId: string;
  readonly sdkStatus: string;
  state: CortexRunState;
  attempts: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: CortexTaskResult;
  error?: string;
}

export interface CortexOrchestratorOptions {
  registry: CortexSdkRegistry;
  policy?: CortexPolicy;
  logger?: CortexLogger;
  /** Maximum tasks running at once. Bounded to the machine, not the vendor. */
  maxConcurrency?: number;
  /** Default per-task budget when the task does not set one. */
  defaultTimeoutMs?: number;
  /** Hard ceiling a task may not exceed, regardless of what it asks for. */
  maxTimeoutMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface CortexTaskRequest {
  readonly taskId: string;
  readonly capability: CortexCapability;
  readonly instruction: string;
  readonly workspace: CortexSdkTask['workspace'];
  readonly acceptanceCriteria: readonly string[];
  readonly timeoutMs?: number;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface CortexBatchOptions {
  readonly signal?: AbortSignal;
  /** Tasks that must finish first; their taskIds are awaited in order. */
  readonly dependsOn?: Readonly<Record<string, readonly string[]>>;
  readonly maxConcurrency?: number;
}

const TERMINAL_STATES: readonly CortexRunState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
  'unavailable',
  'denied',
  'skipped',
];

function isTerminal(state: CortexRunState): boolean {
  return TERMINAL_STATES.includes(state);
}

function statusFromError(error: unknown): CortexRunState {
  if (error instanceof CortexTimeoutError) return 'timed-out';
  if (error instanceof CortexCancelledError) return 'cancelled';
  if (error instanceof CortexSdkUnavailableError) return 'unavailable';
  if (error instanceof CortexError && error.code === 'PERMISSION_DENIED') return 'denied';
  return 'failed';
}

/**
 * Runs CORTEX tasks through the SDK registry with bounded concurrency, hard
 * timeouts, cooperative cancellation and resumable bookkeeping.
 *
 * One SDK failing or being absent only fails the tasks assigned to it; the rest
 * of the batch keeps running.
 */
export class CortexOrchestrator {
  private readonly registry: CortexSdkRegistry;
  private readonly policy: CortexPolicy;
  private readonly logger: CortexLogger;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly now: () => Date;
  private readonly records = new Map<string, CortexRunRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly results = new Map<string, CortexTaskResult>();
  private readonly pendingRequests = new Map<string, CortexTaskRequest>();

  constructor(options: CortexOrchestratorOptions) {
    this.registry = options.registry;
    this.policy = options.policy ?? new CortexPolicy();
    this.logger = options.logger ?? new CortexLogger({ minLevel: 'warn' });
    this.defaultTimeoutMs = clampNumber(options.defaultTimeoutMs, 10 * 60_000, 1_000, 60 * 60_000, 'defaultTimeoutMs');
    this.maxTimeoutMs = clampNumber(options.maxTimeoutMs, 60 * 60_000, this.defaultTimeoutMs, 6 * 60 * 60_000, 'maxTimeoutMs');
    this.maxConcurrency = clampNumber(options.maxConcurrency, 4, 1, 32, 'maxConcurrency');
    this.now = options.now ?? (() => new Date());
  }

  /** Queue one task. Returns the record so callers can watch its state. */
  enqueue(request: CortexTaskRequest): CortexRunRecord {
    this.validateRequest(request);
    if (this.records.has(request.taskId)) {
      throw new CortexValidationError(`taskId ${request.taskId} was already submitted.`);
    }
    const adapter = this.registry.forCapability(request.capability);
    const record: CortexRunRecord = {
      taskId: request.taskId,
      capability: request.capability,
      sdkId: adapter.descriptor.id,
      sdkStatus: adapter.descriptor.status,
      state: 'queued',
      attempts: 0,
      queuedAt: this.now().toISOString(),
    };
    this.records.set(request.taskId, record);
    return record;
  }

  /**
   * Run a batch. Dependencies are honoured; independent tasks run up to the
   * concurrency limit. Never throws for a failing SDK: inspect the records.
   */
  async runBatch(requests: readonly CortexTaskRequest[], options: CortexBatchOptions = {}): Promise<CortexRunRecord[]> {
    if (requests.length === 0) return [];
    const concurrency = clampNumber(
      options.maxConcurrency,
      this.maxConcurrency,
      1,
      this.maxConcurrency,
      'maxConcurrency',
    );
    const byId = new Map(requests.map((request) => [request.taskId, request]));
    if (byId.size !== requests.length) {
      throw new CortexValidationError('every task in a batch must have a unique taskId.');
    }
    const dependsOn = options.dependsOn ?? {};
    for (const request of requests) {
      for (const dependency of dependsOn[request.taskId] ?? []) {
        if (!byId.has(dependency)) {
          throw new CortexValidationError(`task ${request.taskId} depends on unknown task ${dependency}.`);
        }
        if (dependency === request.taskId) {
          throw new CortexValidationError(`task ${request.taskId} cannot depend on itself.`);
        }
      }
    }
    assertNoDependencyCycles(dependsOn);

    // Every task gets a record up front, including ones that will later be
    // skipped, so the caller can always read a terminal state for each taskId.
    for (const request of requests) this.enqueue(request);

    const pending = new Set(byId.keys());
    const completed = new Set<string>();
    const failed = new Set<string>();

    // Wave loop: each pass runs as many ready tasks as the concurrency limit
    // allows, then the next wave is chosen. This keeps one slow SDK from
    // blocking a ready task in an unrelated capability.
    while (pending.size > 0) {
      if (options.signal?.aborted) {
        for (const taskId of pending) this.markSkipped(taskId, 'batch was cancelled before the task started.');
        pending.clear();
        break;
      }

      const ready = [...pending].filter((taskId) =>
        (dependsOn[taskId] ?? []).every((dependency) => completed.has(dependency) || failed.has(dependency)),
      );
      if (ready.length === 0) {
        throw new CortexValidationError('no runnable tasks remain; dependency graph is unsatisfiable.');
      }

      const blocked = ready.filter((taskId) =>
        (dependsOn[taskId] ?? []).some((dependency) => failed.has(dependency)),
      );
      for (const taskId of blocked) {
        this.markSkipped(taskId, 'a dependency failed, so this task was not started.');
        failed.add(taskId);
        completed.add(taskId);
        pending.delete(taskId);
      }

      const wave = ready.filter((taskId) => pending.has(taskId)).slice(0, concurrency);
      if (wave.length === 0) continue;

      const records = await Promise.all(
        wave.map((taskId) => this.runTask(byId.get(taskId)!, options.signal)),
      );
      for (const record of records) {
        completed.add(record.taskId);
        pending.delete(record.taskId);
        if (record.state !== 'succeeded') failed.add(record.taskId);
      }
    }

    return requests.map((request) => this.records.get(request.taskId)!);
  }

  /** Run a single task and return its terminal record. */
  async runTask(request: CortexTaskRequest, signal?: AbortSignal): Promise<CortexRunRecord> {
    const record = this.records.get(request.taskId) ?? this.enqueue(request);
    if (isTerminal(record.state)) return record;

    const adapter = this.registry.forCapability(request.capability);
    record.state = 'running';
    record.startedAt = this.now().toISOString();
    record.attempts += 1;

    const controller = new AbortController();
    this.controllers.set(request.taskId, controller);
    const abortFromParent = () => controller.abort(new CortexCancelledError(`task ${request.taskId}`));
    signal?.addEventListener('abort', abortFromParent, { once: true });

    const timeoutMs = clampNumber(
      request.timeoutMs,
      this.defaultTimeoutMs,
      1_000,
      this.maxTimeoutMs,
      'timeoutMs',
    );

    const ctx: CortexAdapterContext = {
      signal: controller.signal,
      deadlineMs: Date.now() + timeoutMs,
      log: (event) => this.logger.log({ ...event, taskId: request.taskId }),
      authorize: (permission) => this.policy.authorize(permission),
    };

    const task: CortexSdkTask = {
      taskId: request.taskId,
      capability: request.capability,
      instruction: request.instruction,
      workspace: request.workspace,
      acceptanceCriteria: request.acceptanceCriteria,
      timeoutMs,
      options: request.options,
    };

    this.logger.log({
      level: 'info',
      sdkId: adapter.descriptor.id,
      taskId: request.taskId,
      message: 'task started',
      data: { capability: request.capability, timeoutMs, status: adapter.descriptor.status },
    });

    // The deadline is enforced here, not trusted to the adapter: an adapter
    // that ignores its signal cannot hold the batch open past its budget. The
    // abort reason lets the catch block tell a timeout from a cancellation.
    const deadlineTimer = setTimeout(() => controller.abort(new CortexTimeoutError(
      `${adapter.descriptor.id} task ${request.taskId}`,
      timeoutMs,
    )), timeoutMs);
    try {
      const available = await withDeadline(adapter.isAvailable(), ctx, `${adapter.descriptor.id} availability`);
      if (!available) {
        throw new CortexSdkUnavailableError(adapter.descriptor.id, 'isAvailable() reported false.');
      }
      const adapterRun = adapter.run(task, ctx);
      // A late rejection from an adapter that keeps working after its abort
      // would otherwise surface as an unhandled rejection in the host process.
      adapterRun.catch(() => { /* already reported through the deadline race */ });
      const result = await withDeadline(
        adapterRun,
        ctx,
        `${adapter.descriptor.id} task ${request.taskId}`,
      );
      this.assertResultMatchesTask(result, task, adapter.descriptor.id);
      record.result = result;
      record.state = result.status;
      this.results.set(request.taskId, result);
    } catch (error) {
      record.state = statusFromError(error);
      // An adapter that observes its abort surfaces its own error, and that
      // error says nothing about why the abort happened. The orchestrator owns
      // the reason, so it overrides the adapter's guess.
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        record.state = reason instanceof CortexTimeoutError
          ? 'timed-out'
          : reason instanceof CortexCancelledError
            ? 'cancelled'
            : record.state;
      }
      record.error = safeErrorMessage(record.state === 'timed-out' ? controller.signal.reason : error);
      this.logger.log({
        level: record.state === 'cancelled' ? 'warn' : 'error',
        sdkId: adapter.descriptor.id,
        taskId: request.taskId,
        message: 'task finished with an error',
        data: { state: record.state, error: record.error },
      });
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abortFromParent);
      this.controllers.delete(request.taskId);
      record.finishedAt = this.now().toISOString();
      this.logger.log({
        level: record.state === 'succeeded' ? 'info' : 'warn',
        sdkId: adapter.descriptor.id,
        taskId: request.taskId,
        message: 'task completed',
        data: { state: record.state },
      });
    }
    return record;
  }

  /**
   * Ask a running task to stop. The adapter must observe its signal; this only
   * raises the flag and records the request.
   */
  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort(new CortexCancelledError(`task ${taskId}`));
    return true;
  }

  /**
   * Re-run a task that ended in a retryable state. Succeeded, denied and
   * unavailable tasks are not retried automatically: retrying an absent SDK or
   * a policy decision would only waste budget.
   */
  async resume(taskId: string, signal?: AbortSignal): Promise<CortexRunRecord> {
    const record = this.records.get(taskId);
    if (!record) throw new CortexValidationError(`taskId ${taskId} is unknown.`);
    if (record.state === 'succeeded' || record.state === 'denied' || record.state === 'unavailable') {
      return record;
    }
    const request = this.pendingRequests.get(taskId);
    if (!request) throw new CortexValidationError(`task ${taskId} cannot be resumed: its request is gone.`);
    record.state = 'queued';
    record.error = undefined;
    record.finishedAt = undefined;
    return this.runTask(request, signal);
  }

  records_(): readonly CortexRunRecord[] {
    return [...this.records.values()];
  }

  record(taskId: string): CortexRunRecord | undefined {
    return this.records.get(taskId);
  }

  result(taskId: string): CortexTaskResult | undefined {
    return this.results.get(taskId);
  }

  /** Which SDK actually served each task, for the "SDK used" UI panel. */
  sdkProvenance(): Array<{ taskId: string; sdkId: string; capability: CortexCapability; state: CortexRunState }> {
    return [...this.records.values()].map((record) => ({
      taskId: record.taskId,
      sdkId: record.sdkId,
      capability: record.capability,
      state: record.state,
    }));
  }

  private validateRequest(request: CortexTaskRequest): void {
    if (!request.taskId?.trim()) throw new CortexValidationError('taskId is required.');
    if (request.taskId.length > 120) throw new CortexValidationError('taskId is too long.');
    if (!request.instruction?.trim()) throw new CortexValidationError('instruction is required.');
    if (request.instruction.length > 30_000) {
      throw new CortexValidationError('instruction must be at most 30000 characters.');
    }
    if (!Array.isArray(request.acceptanceCriteria) || request.acceptanceCriteria.length === 0) {
      throw new CortexValidationError('at least one acceptance criterion is required.');
    }
    if (request.acceptanceCriteria.some((item) => !item.trim() || item.length > 2_000)) {
      throw new CortexValidationError('acceptance criteria must be non-empty and at most 2000 characters.');
    }
    if (!request.workspace?.hostRoot?.trim()) throw new CortexValidationError('workspace.hostRoot is required.');
    this.pendingRequests.set(request.taskId, request);
  }

  private assertResultMatchesTask(result: CortexTaskResult, task: CortexSdkTask, sdkId: string): void {
    if (!result || typeof result !== 'object') {
      throw new CortexValidationError(`${sdkId} returned no result object.`);
    }
    if (result.taskId !== task.taskId) {
      throw new CortexValidationError(`${sdkId} returned a result for the wrong taskId.`);
    }
    if (result.sdkId !== sdkId) {
      throw new CortexValidationError(`${sdkId} returned a result claiming sdkId ${result.sdkId}.`);
    }
    const allowed: CortexTaskStatus[] = [
      'succeeded',
      'failed',
      'cancelled',
      'timed-out',
      'unavailable',
      'denied',
    ];
    if (!allowed.includes(result.status)) {
      throw new CortexValidationError(`${sdkId} returned an unknown status ${String(result.status)}.`);
    }
  }

  private markSkipped(taskId: string, reason: string): void {
    const record = this.records.get(taskId);
    if (!record) return;
    record.state = 'skipped';
    record.error = reason;
    record.finishedAt = this.now().toISOString();
    this.logger.log({
      level: 'warn',
      sdkId: record.sdkId,
      taskId,
      message: 'task skipped',
      data: { reason },
    });
  }
}

/** Detect cycles up front so a batch cannot deadlock. */
export function assertNoDependencyCycles(
  dependsOn: Readonly<Record<string, readonly string[]>>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, trail: string[]): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new CortexValidationError(
        `dependency cycle detected: ${[...trail, node].join(' -> ')}.`,
      );
    }
    visiting.add(node);
    for (const next of dependsOn[node] ?? []) visit(next, [...trail, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of Object.keys(dependsOn)) visit(node, []);
}
