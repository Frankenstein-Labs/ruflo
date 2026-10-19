/**
 * CORTEX Agent OS — public surface.
 *
 * Ten independent SDK integrations behind one contract, a registry that
 * reports the honest status of each, a policy that fails closed, and an
 * orchestrator with bounded concurrency, deadlines and cancellation.
 */
export {
  CORTEX_CAPABILITIES,
  statusRank,
  type CortexAdapterContext,
  type CortexCapability,
  type CortexIntegrationStatus,
  type CortexLogEvent,
  type CortexPermissionDecision,
  type CortexPermissionRequest,
  type CortexSdkAdapter,
  type CortexSdkAdapterFactory,
  type CortexSdkDescriptor,
  type CortexSdkTask,
  type CortexSensitiveOperation,
  type CortexTaskArtifact,
  type CortexTaskResult,
  type CortexTaskStatus,
  type CortexWorkspaceScope,
} from './types';

export {
  CortexCancelledError,
  CortexDescriptorError,
  CortexError,
  CortexPermissionError,
  CortexSdkUnavailableError,
  CortexTimeoutError,
  CortexValidationError,
  type CortexRegistryEntry,
} from './errors';

export {
  REDACTED,
  assertInsideRoot,
  assertLive,
  assertSafeGitRef,
  assertSafeSegment,
  assertUsableRoot,
  authorize,
  clampNumber,
  redactText,
  redactValue,
  safeErrorMessage,
  safeExec,
  withDeadline,
  type SafeExecOptions,
  type SafeExecResult,
} from './security';

export {
  CortexSdkRegistry,
  defineAdapter,
  probeRegistry,
  type CortexAdapterAvailability,
} from './runtime/registry';
export {
  CortexLogger,
  type CortexLoggerOptions,
  type CortexStructuredLogEntry,
} from './runtime/logger';
export {
  CortexPolicy,
  allowlistPolicy,
  type CortexPolicyOptions,
  type CortexPolicyRule,
} from './runtime/policy';
export {
  CortexOrchestrator,
  assertNoDependencyCycles,
  type CortexBatchOptions,
  type CortexOrchestratorOptions,
  type CortexRunRecord,
  type CortexRunState,
  type CortexTaskRequest,
} from './runtime/orchestrator';

export { createDefaultRegistry, type CortexAdapterOptions } from './adapters';
export { OpenHandsAdapter, OPENHANDS_DESCRIPTOR, type OpenHandsAdapterOptions } from './adapters/openhandsAdapter';
export { LangGraphAdapter, LANGGRAPH_DESCRIPTOR, extractObjectives, type LangGraphAdapterOptions } from './adapters/langgraphAdapter';
export { ViteAdapter, VITE_DESCRIPTOR, type ViteAdapterOptions } from './adapters/viteAdapter';
export { FastifyAdapter, FASTIFY_DESCRIPTOR, assertLoopbackHost, type FastifyAdapterOptions } from './adapters/fastifyAdapter';
export { DrizzleAdapter, DRIZZLE_DESCRIPTOR, type DrizzleAdapterOptions, type DrizzleTableSpec } from './adapters/drizzleAdapter';
export { VitestAdapter, VITEST_DESCRIPTOR, type VitestAdapterOptions } from './adapters/vitestAdapter';
export { CycloneDxAdapter, CYCLONEDX_DESCRIPTOR, type CycloneDxAdapterOptions, type DependencyComponent } from './adapters/cyclonedxAdapter';
export { TypeDocAdapter, TYPEDOC_DESCRIPTOR, type TypeDocAdapterOptions } from './adapters/typedocAdapter';
export { AutocannonAdapter, AUTOCANNON_DESCRIPTOR, type AutocannonAdapterOptions } from './adapters/autocannonAdapter';
export { OctokitAdapter, OCTOKIT_DESCRIPTOR, type OctokitAdapterOptions } from './adapters/octokitAdapter';
export {
  buildResult,
  failureResult,
  successResult,
  type BuildResultOptions,
} from './adapters/shared';

export {
  CORTEX_WORKSPACE_LIMITS,
  CortexWorkspaceManager,
  type CortexWorkspaceManagerOptions,
  type CortexWorkspaceRecord,
  type CortexWorkspaceStatus,
} from './runtime/workspace';
export {
  CortexTaskStore,
  type CortexTaskStoreOptions,
  type CortexTaskView,
} from './runtime/taskStore';
export {
  CORTEX_IDE_VIEW_KEYS,
  buildCortexIdeSnapshot,
  type CortexIdeSnapshot,
  type CortexIdeViewKey,
} from './runtime/ideSnapshot';
export {
  CAPABILITY_TO_SWARM_ROLE,
  CortexSwarmBridge,
  CortexWorkspaceProvisionerBridge,
  describeSwarmOutcome,
  type CortexSwarmOptions,
  type CortexSwarmOutcome,
  type CortexSwarmTaskRequest,
} from './runtime/swarm';
