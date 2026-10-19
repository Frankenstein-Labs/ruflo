import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CortexCancelledError,
  CortexPermissionError,
  CortexTimeoutError,
  CortexValidationError,
} from './errors';
import type {
  CortexAdapterContext,
  CortexPermissionRequest,
  CortexSensitiveOperation,
} from './types';

const execFile = promisify(nodeExecFile);

/**
 * Names whose values must never reach logs, results or error messages.
 * Matched case-insensitively; the value itself is never inspected.
 */
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|credential|session[_-]?key|authorization|bearer|private[_-]?key)/i;

/** Token shapes that must be redacted even when the key name looks innocent. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
];

export const REDACTED = '[redacted]';

/** Redact a single string: known token shapes first, then secret-looking assignments. */
export function redactText(input: string, maxLength = 2000): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(
    /((?:[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|credential|session[_-]?key|authorization|bearer|private[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*)("?)([^\s"',;]{3,})\2/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  );
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…[truncated]`;
  return out;
}

/** Recursively redact secret-looking keys in a structured value. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

/** Redact a thrown error into a safe, single-line message. */
export function safeErrorMessage(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? 'unknown error';
  return redactText(firstLine, maxLength);
}

/**
 * Validate a value that becomes part of a branch name, directory name or CLI
 * argument. Rejects anything that could be read as a flag or escape a path.
 */
export function assertSafeSegment(value: string, field: string, maxLength = 80): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new CortexValidationError(`${field} must not be empty.`);
  if (trimmed.length > maxLength) {
    throw new CortexValidationError(`${field} must be at most ${maxLength} characters.`);
  }
  if (trimmed.startsWith('-')) {
    throw new CortexValidationError(`${field} must not start with a dash.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new CortexValidationError(
      `${field} must contain only letters, numbers, dot, underscore or hyphen.`,
    );
  }
  return trimmed;
}

/** Validate a Git ref (branch or revision) without invoking a shell. */
export function assertSafeGitRef(value: string, field = 'gitRef', maxLength = 200): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new CortexValidationError(`${field} must not be empty.`);
  if (trimmed.length > maxLength) {
    throw new CortexValidationError(`${field} must be at most ${maxLength} characters.`);
  }
  // Rejects leading dash (option injection), whitespace, control characters and
  // the ref characters git itself forbids: ~ ^ : ? * [ \ and "..".
  if (/[\u0000-\u001f\u007f\s~^:?*[\\]/.test(trimmed) || trimmed.includes('..') || trimmed.includes('@{')) {
    throw new CortexValidationError(`${field} contains characters that are not valid in a Git ref.`);
  }
  if (trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.')) {
    throw new CortexValidationError(`${field} must not start with a dash or a slash, or end with a slash or a dot.`);
  }
  return trimmed;
}

/**
 * Resolve `candidate` and prove it stays inside `root`. Uses realpath-free
 * lexical containment so it also works for paths that do not exist yet.
 */
export function assertInsideRoot(root: string, candidate: string, field: string): string {
  if (!path.isAbsolute(root)) throw new CortexValidationError(`${field} root must be an absolute path.`);
  if (!path.isAbsolute(candidate)) throw new CortexValidationError(`${field} must be an absolute path.`);
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '') {
    throw new CortexValidationError(`${field} must be a child of the workspace root, not the root itself.`);
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CortexValidationError(`${field} is outside the configured workspace root.`);
  }
  return resolvedCandidate;
}

/** Reject a workspace root that would hand an SDK the whole filesystem. */
export function assertUsableRoot(root: string, field = 'workspaceRoot'): string {
  if (!path.isAbsolute(root)) throw new CortexValidationError(`${field} must be an absolute path.`);
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new CortexValidationError(`${field} must not be the filesystem root.`);
  }
  return resolved;
}

/** Bound a numeric option to an inclusive range. */
export function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CortexValidationError(`${field} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new CortexValidationError(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}

/** A context whose deadline already elapsed or whose signal fired. */
export function assertLive(ctx: CortexAdapterContext, scope: string): void {
  if (ctx.signal.aborted) throw new CortexCancelledError(scope);
  if (Date.now() >= ctx.deadlineMs) {
    throw new CortexTimeoutError(scope, Math.max(0, Date.now() - ctx.deadlineMs));
  }
}

/** Races a promise against the context deadline and cancellation signal. */
export async function withDeadline<T>(
  promise: Promise<T>,
  ctx: CortexAdapterContext,
  scope: string,
): Promise<T> {
  const remaining = ctx.deadlineMs - Date.now();
  if (ctx.signal.aborted) throw new CortexCancelledError(scope);
  if (remaining <= 0) throw new CortexTimeoutError(scope, 0);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CortexTimeoutError(scope, remaining)), remaining);
        onAbort = () => reject(new CortexCancelledError(scope));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Guard a sensitive operation through the policy layer before it happens. */
export function authorize(
  ctx: CortexAdapterContext,
  sdkId: string,
  operation: CortexSensitiveOperation,
  detail: string,
): void {
  const request: CortexPermissionRequest = { sdkId, operation, detail: redactText(detail, 200) };
  const decision = ctx.authorize(request);
  ctx.log({
    level: decision.allowed ? 'debug' : 'warn',
    sdkId,
    message: `policy ${decision.allowed ? 'allowed' : 'denied'} ${operation}`,
    data: { detail: request.detail, reason: decision.reason },
  });
  if (!decision.allowed) throw new CortexPermissionError(sdkId, operation, decision.reason);
}

export interface SafeExecOptions {
  /** argv form only; there is no shell-string variant by design. */
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxBufferBytes?: number;
  /** Environment allowlist; only these keys are forwarded to the child. */
  envAllowlist?: readonly string[];
  extraEnv?: Readonly<Record<string, string>>;
}

export interface SafeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a child process without a shell, with a bounded buffer, a timeout and a
 * filtered environment. Output is returned raw to the caller but must be
 * redacted before it is logged or stored.
 */
export async function safeExec(options: SafeExecOptions): Promise<SafeExecResult> {
  const { command, args, cwd, timeoutMs } = options;
  if (!command.trim()) throw new CortexValidationError('command must not be empty.');
  if (args.some((arg) => typeof arg !== 'string')) {
    throw new CortexValidationError('every argument must be a string.');
  }
  const env: Record<string, string> = { ...(options.extraEnv ?? {}) };
  for (const key of options.envAllowlist ?? ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_ENV']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  try {
    const result = await execFile(command, [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: options.maxBufferBytes ?? 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      env,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (failure.code === 'ENOENT') {
      throw new CortexValidationError(`Command not found: ${command}`);
    }
    if (failure.killed || failure.signal) {
      throw new CortexTimeoutError(`command ${command}`, timeoutMs);
    }
    if (typeof failure.code === 'number') {
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
    }
    throw error;
  }
}
