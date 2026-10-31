import type { NormalizedResource } from "./types.js";
import { policy, type DenyListEntry } from "./policy.js";

export interface DenyListViolation {
  code: string;
  resourceType: string;
  resourceName: string;
  reason: string;
}

function attributesMatch(
  resource: NormalizedResource,
  attributeDeny: Record<string, unknown>,
): boolean {
  return Object.entries(attributeDeny).every(([key, expected]) => {
    const actual = resource.attributes[key];
    if (expected === null) return actual === null || actual === undefined;
    return actual === expected;
  });
}

function matches(resource: NormalizedResource, entry: DenyListEntry): boolean {
  if (!entry.resourceTypes.includes(resource.type)) return false;
  if (!entry.attributeDeny) return true;
  return attributesMatch(resource, entry.attributeDeny);
}

/**
 * Checks every resource against Sec. 2.3's deny-list. Mode-independent on
 * purpose: this reports what a plan actually contains. Whether a violation
 * blocks the pipeline (strict) or requires cost-labelled user confirmation
 * (flexible) is a pipeline-level decision made by the caller, not this
 * function -- see the `evaluateFreeTier` doc comment.
 */
export function checkDenyList(resources: NormalizedResource[]): DenyListViolation[] {
  const violations: DenyListViolation[] = [];
  for (const resource of resources) {
    for (const entry of policy.denyList) {
      if (matches(resource, entry)) {
        violations.push({
          code: entry.code,
          resourceType: resource.type,
          resourceName: resource.name,
          reason: entry.reason,
        });
      }
    }
  }
  return violations;
}
