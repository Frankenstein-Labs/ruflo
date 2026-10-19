import { statusRank } from '../types';
import type { CortexCapability } from '../types';
import type { CortexAdapterAvailability } from './registry';
import type { CortexRunRecord } from './orchestrator';
import type { CortexTaskView } from './taskStore';
import type { CortexWorkspaceRecord } from './workspace';

export const CORTEX_IDE_VIEW_KEYS = [
  'sdks',
  'tasks',
  'workspaces',
  'conflicts',
  'coverage',
  'provenance',
] as const;

export type CortexIdeViewKey = (typeof CORTEX_IDE_VIEW_KEYS)[number];

export interface CortexIdeSnapshot {
  readonly generatedAt: string;
  readonly sdks: readonly CortexAdapterAvailability[];
  readonly tasks: readonly CortexTaskView[];
  readonly workspaces: readonly CortexWorkspaceRecord[];
  readonly conflicts: readonly { a: string; b: string; files: readonly string[] }[];
  /** Coverage states are reported per capability, never as a single percentage. */
  readonly coverage: {
    readonly capabilitiesTotal: number;
    readonly withAvailableSdk: number;
    readonly liveTested: number;
    readonly gaps: readonly string[];
  };
  readonly provenance: readonly {
    readonly taskId: string;
    readonly sdkId: string;
    readonly capability: string;
    readonly state: string;
  }[];
  /** Capabilities whose SDK is only mocked; the UI must not imply otherwise. */
  readonly unverifiedClaims: readonly string[];
}

export interface BuildIdeSnapshotInput {
  availability: readonly CortexAdapterAvailability[];
  tasks: readonly CortexTaskView[];
  workspaces: readonly CortexWorkspaceRecord[];
  conflicts?: readonly { a: string; b: string; files: readonly string[] }[];
  /** Every capability CORTEX is supposed to cover, so gaps can be computed. */
  capabilities: readonly CortexCapability[];
  runs?: readonly CortexRunRecord[];
  now?: () => Date;
}

/**
 * Build the Cloud IDE view model. It intentionally reports capability counts
 * instead of a single "% complete" number, because a headline percentage would
 * overstate how far the integrations have actually been taken.
 */
export function buildCortexIdeSnapshot(input: BuildIdeSnapshotInput): CortexIdeSnapshot {
  const available = input.availability.filter((entry) => entry.available);
  const liveTested = input.availability.filter(
    (entry) => statusRank(entry.status) >= statusRank('live-tested'),
  );
  const coveredCapabilities = new Set(available.map((entry) => entry.capability));
  const gaps = input.capabilities.filter((capability) => !coveredCapabilities.has(capability));

  const unverifiedClaims = input.availability
    .filter((entry) => entry.status === 'integrated' && !entry.available)
    .map((entry) => `${entry.sdkId}: registered but its package is not resolvable here`);
  const runs = input.runs ?? [];
  const provenance = runs.map((run) => ({
    taskId: run.taskId,
    sdkId: run.sdkId,
    capability: run.capability,
    state: run.state,
  }));

  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    sdks: input.availability,
    tasks: input.tasks,
    workspaces: input.workspaces,
    conflicts: input.conflicts ?? [],
    coverage: {
      capabilitiesTotal: input.capabilities.length,
      withAvailableSdk: coveredCapabilities.size,
      liveTested: liveTested.length,
      gaps,
    },
    provenance,
    unverifiedClaims,
  };
}
