import type { CortexCapability, CortexSdkDescriptor } from './types';

/** Base class so the orchestrator can distinguish CORTEX failures from bugs. */
export class CortexError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CortexError';
    this.code = code;
  }
}

/** Thrown when an SDK's package or binary is not resolvable in this environment. */
export class CortexSdkUnavailableError extends CortexError {
  constructor(readonly sdkId: string, reason: string) {
    super('SDK_UNAVAILABLE', `${sdkId} is unavailable: ${reason}`);
    this.name = 'CortexSdkUnavailableError';
  }
}

/** Thrown when the policy layer refuses a sensitive operation. */
export class CortexPermissionError extends CortexError {
  constructor(readonly sdkId: string, operation: string, reason: string) {
    super('PERMISSION_DENIED', `${sdkId} was denied ${operation}: ${reason}`);
    this.name = 'CortexPermissionError';
  }
}

/** Thrown when input validation fails; message must stay safe to display. */
export class CortexValidationError extends CortexError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message);
    this.name = 'CortexValidationError';
  }
}

export class CortexTimeoutError extends CortexError {
  constructor(scope: string, timeoutMs: number) {
    super('TIMEOUT', `${scope} exceeded its ${timeoutMs} ms budget.`);
    this.name = 'CortexTimeoutError';
  }
}

export class CortexCancelledError extends CortexError {
  constructor(scope: string) {
    super('CANCELLED', `${scope} was cancelled.`);
    this.name = 'CortexCancelledError';
  }
}

/** A descriptor whose claim is not backed by evidence in this repository. */
export class CortexDescriptorError extends CortexError {
  constructor(descriptor: Pick<CortexSdkDescriptor, 'id'>, message: string) {
    super('INVALID_DESCRIPTOR', `Descriptor for ${descriptor.id} is invalid: ${message}`);
    this.name = 'CortexDescriptorError';
  }
}

export interface CortexRegistryEntry {
  readonly descriptor: CortexSdkDescriptor;
  readonly capability: CortexCapability;
}
