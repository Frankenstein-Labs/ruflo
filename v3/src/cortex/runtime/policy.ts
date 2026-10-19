import { CortexValidationError } from '../errors';
import type {
  CortexPermissionDecision,
  CortexPermissionRequest,
  CortexSensitiveOperation,
} from '../types';

export interface CortexPolicyRule {
  readonly sdkId: string;
  readonly operation: CortexSensitiveOperation;
  readonly allowed: boolean;
  /** Optional substring the detail must contain for this rule to match. */
  readonly detailIncludes?: string;
}

export interface CortexPolicyOptions {
  /** Rules are evaluated in order; the first match wins. */
  rules?: readonly CortexPolicyRule[];
  /** Decision when no rule matches. Defaults to deny: fail closed. */
  defaultAllowed?: boolean;
  /** Capability-scoped allowlist of SDK ids permitted to spawn processes. */
  processAllowlist?: readonly string[];
}

/**
 * Decides whether an adapter may perform a sensitive operation. The default is
 * to deny, so a newly added SDK cannot reach the network or spawn a process
 * until an operator grants it explicitly.
 */
export class CortexPolicy {
  private readonly rules: readonly CortexPolicyRule[];
  private readonly defaultAllowed: boolean;
  private readonly processAllowlist: ReadonlySet<string>;
  private readonly decisions: CortexPermissionRequest[] = [];

  constructor(options: CortexPolicyOptions = {}) {
    this.rules = options.rules ?? [];
    this.defaultAllowed = options.defaultAllowed ?? false;
    this.processAllowlist = new Set(options.processAllowlist ?? []);
    if (this.defaultAllowed) {
      throw new CortexValidationError(
        'CortexPolicy must fail closed: defaultAllowed may not be true without an explicit rule set.',
      );
    }
  }

  authorize(request: CortexPermissionRequest): CortexPermissionDecision {
    if (!request.sdkId.trim()) throw new CortexValidationError('permission request requires an sdkId.');
    this.decisions.push(request);

    if (request.operation === 'spawn-process' && !this.processAllowlist.has(request.sdkId)) {
      return { allowed: false, reason: `${request.sdkId} is not on the process allowlist.` };
    }

    for (const rule of this.rules) {
      if (rule.sdkId !== request.sdkId || rule.operation !== request.operation) continue;
      if (rule.detailIncludes && !request.detail.includes(rule.detailIncludes)) continue;
      return {
        allowed: rule.allowed,
        reason: rule.allowed ? 'matched an explicit allow rule.' : 'matched an explicit deny rule.',
      };
    }
    return {
      allowed: false,
      reason: `no rule grants ${request.operation} to ${request.sdkId}; policy fails closed.`,
    };
  }

  /** Audit trail of every decision, in order. */
  auditTrail(): readonly CortexPermissionRequest[] {
    return [...this.decisions];
  }
}

/**
 * Policy that grants a fixed set of operations to a fixed set of SDKs. Use it
 * to express "these adapters may do exactly this, nothing more".
 */
export function allowlistPolicy(
  grants: ReadonlyArray<{ sdkId: string; operations: readonly CortexSensitiveOperation[] }>,
): CortexPolicy {
  const rules: CortexPolicyRule[] = [];
  const processAllowlist: string[] = [];
  for (const grant of grants) {
    for (const operation of grant.operations) {
      rules.push({ sdkId: grant.sdkId, operation, allowed: true });
      if (operation === 'spawn-process') processAllowlist.push(grant.sdkId);
    }
  }
  return new CortexPolicy({ rules, processAllowlist });
}
