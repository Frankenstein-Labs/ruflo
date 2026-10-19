import { CortexDescriptorError, CortexValidationError } from '../errors';
import { statusRank } from '../types';
import type {
  CortexCapability,
  CortexIntegrationStatus,
  CortexSdkAdapter,
  CortexSdkAdapterFactory,
  CortexSdkDescriptor,
} from '../types';

/** Every descriptor field that must be a non-empty string to be registerable. */
const REQUIRED_STRING_FIELDS = [
  'id',
  'name',
  'packageName',
  'version',
  'license',
  'source',
] as const;

function assertDescriptor(descriptor: CortexSdkDescriptor): void {
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = descriptor[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new CortexDescriptorError(descriptor, `${field} must be a non-empty string.`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(descriptor.id)) {
    throw new CortexDescriptorError(descriptor, 'id must be lower-case kebab-case.');
  }
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length === 0) {
    throw new CortexDescriptorError(descriptor, 'capabilities must list at least one real capability.');
  }
  if (!Array.isArray(descriptor.limitations)) {
    throw new CortexDescriptorError(descriptor, 'limitations must be an array (empty is allowed).');
  }
  // Honesty guard: a status below "integrated" must not claim an adapter runs
  // here, and a status above "identified" must name a concrete package version.
  if (statusRank(descriptor.status) > statusRank('identified') && descriptor.version === 'unknown') {
    throw new CortexDescriptorError(
      descriptor,
      'version must be a concrete pinned version once a package is installed.',
    );
  }
  if (!/^(https:\/\/|git\+https:\/\/)/.test(descriptor.source)) {
    throw new CortexDescriptorError(descriptor, 'source must be an https URL.');
  }
}

/**
 * One entry per functional slot. Registration is idempotent per capability:
 * a second SDK for the same slot is a configuration error, not a silent
 * override, because the mission requires exactly one SDK per slot.
 */
export class CortexSdkRegistry {
  private readonly adapters = new Map<string, CortexSdkAdapter>();
  private readonly byCapability = new Map<CortexCapability, string>();

  register(adapter: CortexSdkAdapter): void {
    assertDescriptor(adapter.descriptor);
    const { id, capability } = adapter.descriptor;
    if (this.adapters.has(id)) {
      throw new CortexValidationError(`SDK id ${id} is already registered.`);
    }
    const existing = this.byCapability.get(capability);
    if (existing) {
      throw new CortexValidationError(
        `Capability ${capability} already has SDK ${existing}; CORTEX allows one SDK per slot.`,
      );
    }
    this.adapters.set(id, adapter);
    this.byCapability.set(capability, id);
  }

  get(sdkId: string): CortexSdkAdapter {
    const adapter = this.adapters.get(sdkId);
    if (!adapter) throw new CortexValidationError(`SDK ${sdkId} is not registered.`);
    return adapter;
  }

  forCapability(capability: CortexCapability): CortexSdkAdapter {
    const id = this.byCapability.get(capability);
    if (!id) throw new CortexValidationError(`No SDK is registered for capability ${capability}.`);
    return this.get(id);
  }

  has(capability: CortexCapability): boolean {
    return this.byCapability.has(capability);
  }

  list(): CortexSdkAdapter[] {
    return [...this.adapters.values()].sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
  }

  descriptors(): CortexSdkDescriptor[] {
    return this.list().map((adapter) => adapter.descriptor);
  }

  /** Capabilities with no SDK at all, so the UI can show real gaps. */
  missingCapabilities(all: readonly CortexCapability[]): CortexCapability[] {
    return all.filter((capability) => !this.byCapability.has(capability));
  }

  async disposeAll(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.dispose?.();
  }
}

export interface CortexAdapterAvailability {
  readonly sdkId: string;
  readonly capability: CortexCapability;
  readonly status: CortexIntegrationStatus;
  readonly available: boolean;
  readonly version: string;
  readonly reason?: string;
}

/**
 * Probes every registered adapter without letting one broken SDK take the
 * others down: a rejected probe becomes `available: false` with a safe reason.
 */
export async function probeRegistry(registry: CortexSdkRegistry): Promise<CortexAdapterAvailability[]> {
  return Promise.all(
    registry.list().map(async (adapter): Promise<CortexAdapterAvailability> => {
      const base = {
        sdkId: adapter.descriptor.id,
        capability: adapter.descriptor.capability,
        status: adapter.descriptor.status,
        version: adapter.descriptor.version,
      };
      try {
        return { ...base, available: await adapter.isAvailable() };
      } catch (error) {
        return {
          ...base,
          available: false,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'availability probe failed',
        };
      }
    }),
  );
}

/** Convenience factory helper so tests can inject fakes per capability. */
export function defineAdapter(factory: CortexSdkAdapterFactory): CortexSdkAdapterFactory {
  return factory;
}
