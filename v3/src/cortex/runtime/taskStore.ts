import path from 'node:path';
import fs from 'node:fs/promises';
import { redactValue } from '../security';
import type { CortexRunRecord, CortexRunState } from './orchestrator';
import type { CortexStructuredLogEntry } from './logger';
import type { CortexSdkTask, CortexTaskResult } from '../types';

export interface CortexTaskStoreOptions {
  /** Directory for the append-only task history. */
  directory: string;
  /** Maximum records kept in memory for the UI. */
  maxInMemory?: number;
  now?: () => Date;
}

export interface CortexTaskView {
  readonly taskId: string;
  readonly capability: string;
  readonly sdkId: string;
  readonly sdkStatus: string;
  readonly state: CortexRunState;
  readonly attempts: number;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly artifactCount: number;
  readonly evidenceKeys: readonly string[];
  readonly changedFiles: readonly string[];
}

/**
 * Durable-ish task history. Records are redacted before they are written, so a
 * task instruction or evidence value containing a secret is never persisted.
 */
export class CortexTaskStore {
  private readonly directory: string;
  private readonly maxInMemory: number;
  private readonly now: () => Date;
  private readonly views = new Map<string, CortexTaskView>();

  constructor(options: CortexTaskStoreOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error('CortexTaskStore directory must be an absolute path.');
    }
    this.directory = options.directory;
    this.maxInMemory = options.maxInMemory ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  /** Record a terminal task state and its redacted evidence. */
  async record(input: {
    run: CortexRunRecord;
    task?: CortexSdkTask;
    result?: CortexTaskResult;
    logs?: readonly CortexStructuredLogEntry[];
    changedFiles?: readonly string[];
  }): Promise<CortexTaskView> {
    const { run, result } = input;
    const view: CortexTaskView = {
      taskId: run.taskId,
      capability: run.capability,
      sdkId: run.sdkId,
      sdkStatus: run.sdkStatus,
      state: run.state,
      attempts: run.attempts,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      artifactCount: result?.artifacts.length ?? 0,
      evidenceKeys: result ? Object.keys(result.evidence) : [],
      changedFiles: [...(input.changedFiles ?? [])],
    };
    this.views.set(run.taskId, view);
    if (this.views.size > this.maxInMemory) {
      const oldest = [...this.views.keys()][0];
      this.views.delete(oldest);
    }
    await this.append(view, input);
    return view;
  }

  list(): CortexTaskView[] {
    return [...this.views.values()];
  }

  byState(state: CortexRunState): CortexTaskView[] {
    return this.list().filter((view) => view.state === state);
  }

  bySdk(sdkId: string): CortexTaskView[] {
    return this.list().filter((view) => view.sdkId === sdkId);
  }

  private async append(
    view: CortexTaskView,
    input: { task?: CortexSdkTask; result?: CortexTaskResult; logs?: readonly CortexStructuredLogEntry[] },
  ): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const entry = {
      recordedAt: this.now().toISOString(),
      view,
      // Instructions are stored redacted: they can contain pasted secrets.
      instruction: input.task ? redactValue(input.task.instruction) : undefined,
      evidence: input.result ? redactValue(input.result.evidence) : undefined,
      logs: (input.logs ?? []).slice(-200),
    };
    const file = path.join(this.directory, `${sanitizeFileName(view.taskId)}.json`);
    await fs.writeFile(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}
