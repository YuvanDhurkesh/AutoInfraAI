import type { NormalizedResource } from "@autoinfra/free-tier-policy";
import type { PlanJson } from "./plan-json.js";

/** Placeholder for attributes Terraform won't know until apply. */
export const KNOWN_AFTER_APPLY = "(known after apply)";

/**
 * Feeds real plan output into the Free Tier evaluator (the shape it was
 * designed around in Milestone 3). Two plan-JSON quirks matter here:
 * unknown values are *omitted* from `after` (and flagged in after_unknown),
 * so they're filled with a placeholder rather than looking "unset" -- an
 * EIP whose instance is unknown at plan time is not unattached; and nested
 * blocks are single-element lists, so root_block_device is unwrapped.
 */
export function planToResources(plan: PlanJson): NormalizedResource[] {
  return (plan.resource_changes ?? [])
    .filter(
      (rc) =>
        rc.mode === "managed" &&
        !(rc.change.actions.length === 1 && rc.change.actions[0] === "delete"),
    )
    .map((rc) => {
      const attributes: Record<string, unknown> = { ...(rc.change.after ?? {}) };
      for (const [key, isUnknown] of Object.entries(rc.change.after_unknown ?? {})) {
        if (isUnknown === true && attributes[key] === undefined)
          attributes[key] = KNOWN_AFTER_APPLY;
      }
      if (Array.isArray(attributes.root_block_device)) {
        attributes.root_block_device = attributes.root_block_device[0];
      }
      return { type: rc.type, name: rc.address, attributes };
    });
}
