import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import {
  CortexSdkUnavailableError,
  CortexValidationError,
} from '../errors';
import { assertInsideRoot, assertUsableRoot, redactText, safeErrorMessage } from '../security';
import type {
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskArtifact,
  CortexTaskResult,
  CortexTaskStatus,
} from '../types';

/**
 * Load an optional SDK by name. Adapters never import their SDK at module
 * scope: a missing package must degrade to `unavailable`, not crash CORTEX or
 * the whole test process.
 */
export async function loadSdk<T = unknown>(packageName: string, sdkId: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ packageName)) as T;
  } catch (error) {
    throw new CortexSdkUnavailableError(sdkId, `could not import ${packageName} (${safeErrorMessage(error, 120)}).`);
  }
}

/** True when the package can be resolved from this workspace. */
export async function canImport(packageName: string): Promise<boolean> {
  try {
    await import(/* @vite-ignore */ packageName);
    return true;
  } catch {
    return false;
  }
}

/** The workspace root for a task, validated and normalised. */
export function taskWorkspaceRoot(task: CortexSdkTask): string {
  if (!task.workspace?.hostRoot) {
    throw new CortexValidationError('task.workspace.hostRoot is required.');
  }
  return assertUsableRoot(task.workspace.hostRoot, 'task.workspace.hostRoot');
}

/** Resolve a task-supplied relative path and prove it stays in the workspace. */
export function resolveInsideWorkspace(task: CortexSdkTask, relativePath: string, field: string): string {
  const root = taskWorkspaceRoot(task);
  if (path.isAbsolute(relativePath)) {
    throw new CortexValidationError(`${field} must be relative to the workspace, not absolute.`);
  }
  return assertInsideRoot(root, path.join(root, relativePath), field);
}

export interface BuildResultOptions {
  task: CortexSdkTask;
  sdkId: string;
  status: CortexTaskStatus;
  startedAt: string;
  artifacts?: readonly CortexTaskArtifact[];
  evidence?: Readonly<Record<string, unknown>>;
  error?: string;
  now?: () => Date;
}

/** Assemble a result that satisfies the CORTEX contract. */
export function buildResult(options: BuildResultOptions): CortexTaskResult {
  return {
    taskId: options.task.taskId,
    sdkId: options.sdkId,
    capability: options.task.capability,
    status: options.status,
    startedAt: options.startedAt,
    finishedAt: (options.now ?? (() => new Date()))().toISOString(),
    artifacts: options.artifacts ?? [],
    evidence: options.evidence ?? {},
    error: options.error ? redactText(options.error, 500) : undefined,
  };
}

/** A successful result whose artifacts were produced by the real SDK. */
export function successResult(options: Omit<BuildResultOptions, 'status'>): CortexTaskResult {
  return buildResult({ ...options, status: 'succeeded' });
}

export function failureResult(options: Omit<BuildResultOptions, 'status'>): CortexTaskResult {
  return buildResult({ ...options, status: 'failed' });
}

/** List files in the workspace matching a simple extension filter. */
export function listWorkspaceFiles(
  root: string,
  options: { extensions?: readonly string[]; maxFiles?: number; ignoreDirs?: readonly string[] } = {},
): string[] {
  const extensions = options.extensions ?? [];
  const maxFiles = options.maxFiles ?? 200;
  const ignoreDirs = new Set(options.ignoreDirs ?? ['node_modules', '.git', 'dist', 'build', 'coverage']);
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (found.length >= maxFiles || depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (ignoreDirs.has(entry)) continue;
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1);
      } else if (extensions.length === 0 || extensions.some((ext) => entry.endsWith(ext))) {
        found.push(path.relative(root, full));
      }
    }
  };

  if (existsSync(root)) walk(root, 0);
  return found;
}

/** Trim SDK output to a safe, non-secret-bearing snippet. */
export function safeSnippet(value: string, maxLength = 400): string {
  return redactText(value.replace(/\s+/g, ' ').trim(), maxLength);
}

/** Coerce an unknown value into a descriptor-safe string list. */
export function toStringArray(value: unknown, maxItems = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, maxItems);
}

/**
 * A guard every adapter uses so a claim of "production-ready" cannot be made
 * by an adapter whose descriptor does not yet justify it.
 */
export function assertDescriptorHonesty(descriptor: CortexSdkDescriptor): void {
  if (descriptor.status === 'production-ready' && descriptor.limitations.length > 0) {
    throw new CortexValidationError(
      `${descriptor.id} claims production-ready but still lists limitations: ${descriptor.limitations.join('; ')}`,
    );
  }
}
