/**
 * CORTEX Agent OS — common SDK integration contract.
 *
 * Every integration is an independent SDK: its own package, licence, version,
 * adapter, error handling and tests. The orchestrator only ever talks to this
 * contract, so adding or removing a vendor never requires touching the others.
 *
 * A registered SDK is not a working SDK. `CortexIntegrationStatus` records how
 * far each integration has actually been taken, and the registry never reports
 * a stronger status than the evidence in this repository supports.
 */

/** Functional slots the mission defines. Each maps to exactly one SDK. */
export type CortexCapability =
  | 'code-execution'
  | 'planning'
  | 'frontend'
  | 'backend'
  | 'data'
  | 'testing'
  | 'security'
  | 'documentation'
  | 'performance'
  | 'review';

export const CORTEX_CAPABILITIES: readonly CortexCapability[] = [
  'code-execution',
  'planning',
  'frontend',
  'backend',
  'data',
  'testing',
  'security',
  'documentation',
  'performance',
  'review',
] as const;

/**
 * Honest integration ladder. A step may only be claimed when its evidence
 * exists in this repository; see docs/CORTEX_SDK_REGISTRY.md.
 *
 * - identified:   official source, version and licence verified from a registry.
 * - installed:    the package resolves and installs in this workspace.
 * - integrated:   an adapter implements the CORTEX contract and is registered.
 * - mock-tested:  adapter tests pass against injected fakes.
 * - live-tested:  the real SDK performed real work in a real environment.
 * - production-ready: live-tested and exercised by the CORTEX runtime.
 */
export type CortexIntegrationStatus =
  | 'identified'
  | 'installed'
  | 'integrated'
  | 'mock-tested'
  | 'live-tested'
  | 'production-ready';

const STATUS_ORDER: readonly CortexIntegrationStatus[] = [
  'identified',
  'installed',
  'integrated',
  'mock-tested',
  'live-tested',
  'production-ready',
];

export function statusRank(status: CortexIntegrationStatus): number {
  return STATUS_ORDER.indexOf(status);
}

export interface CortexSdkDescriptor {
  /** Stable CORTEX id; also the registry key. */
  readonly id: string;
  /** The single functional slot this SDK fills. */
  readonly capability: CortexCapability;
  /** Human name of the SDK product. */
  readonly name: string;
  /** Exact package name in its official registry. */
  readonly packageName: string;
  /** Exact version pinned by this repository. */
  readonly version: string;
  /** SPDX identifier verified from the package metadata. */
  readonly license: string;
  /** Official upstream source URL. */
  readonly source: string;
  /** Which registry the package comes from. */
  readonly registry: 'npm' | 'pypi' | 'container';
  /** How the dependency is declared in this repository. */
  readonly dependencyType: 'dependency' | 'devDependency' | 'optionalDependency' | 'external-service';
  /** Capabilities this adapter can actually perform, in plain terms. */
  readonly capabilities: readonly string[];
  /** Honest integration status. */
  readonly status: CortexIntegrationStatus;
  /** Known limitations that must not be silently dropped. */
  readonly limitations: readonly string[];
}

/** Where a task is allowed to write. Never a user-supplied free-form path. */
export interface CortexWorkspaceScope {
  /** Host path for local tooling and Git operations. */
  readonly hostRoot: string;
  /** Absolute path the workspace has inside a sandbox/Agent Server, if any. */
  readonly sandboxRoot?: string;
  /** Dedicated Git branch for this task, if the adapter writes files. */
  readonly branchName?: string;
}

export interface CortexSdkTask {
  readonly taskId: string;
  readonly capability: CortexCapability;
  /** Instruction for the SDK. Treated as untrusted data by every adapter. */
  readonly instruction: string;
  readonly workspace: CortexWorkspaceScope;
  /** Explicit, machine-checkable criteria; an adapter must not invent success. */
  readonly acceptanceCriteria: readonly string[];
  /** Hard wall-clock budget for this task. */
  readonly timeoutMs?: number;
  /** Adapter-specific options, validated by the adapter itself. */
  readonly options?: Readonly<Record<string, unknown>>;
}

export type CortexTaskStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unavailable'
  | 'denied';

export interface CortexTaskArtifact {
  readonly name: string;
  readonly kind: 'file' | 'report' | 'diff' | 'log' | 'metric';
  /** Repo-relative or workspace-relative path; never an absolute host path. */
  readonly path?: string;
  /** Inline summary safe to display; must contain no secrets. */
  readonly summary?: string;
}

export interface CortexTaskResult {
  readonly taskId: string;
  readonly sdkId: string;
  readonly capability: CortexCapability;
  readonly status: CortexTaskStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly artifacts: readonly CortexTaskArtifact[];
  /** Redacted, structured evidence. Never raw command output. */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

/** Runtime context handed to an adapter; adapters must not read globals. */
export interface CortexAdapterContext {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  /** Structured, redacting logger. */
  readonly log: (event: CortexLogEvent) => void;
  /** Ask the policy layer before a sensitive operation. */
  readonly authorize: (request: CortexPermissionRequest) => CortexPermissionDecision;
}

export interface CortexLogEvent {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly sdkId: string;
  readonly taskId?: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type CortexSensitiveOperation =
  | 'network'
  | 'spawn-process'
  | 'write-workspace'
  | 'git-write'
  | 'read-secret'
  | 'publish';

export interface CortexPermissionRequest {
  readonly sdkId: string;
  readonly operation: CortexSensitiveOperation;
  readonly detail: string;
}

export interface CortexPermissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** The contract every SDK integration implements. */
export interface CortexSdkAdapter {
  readonly descriptor: CortexSdkDescriptor;
  /**
   * Resolve the real package and report whether this integration can run here.
   * Must never throw; a missing SDK is `false`, not a crash.
   */
  isAvailable(): Promise<boolean>;
  /** Execute one bounded task. Must honour `ctx.signal` and `ctx.deadlineMs`. */
  run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult>;
  /** Release any resources the adapter holds. Optional. */
  dispose?(): Promise<void>;
}

export type CortexSdkAdapterFactory = () => CortexSdkAdapter;
