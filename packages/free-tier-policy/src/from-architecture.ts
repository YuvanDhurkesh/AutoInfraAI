import type { ArchitecturePlan } from "@autoinfra/shared";
import type { NormalizedResource } from "./types.js";

/**
 * Translates an ArchitecturePlan's components into the same resource shape
 * the evaluator will later get from real Terraform plans (Milestone 6), so a
 * design can be judged before any Terraform exists. Only the sizing fields
 * the evaluator actually checks are mapped.
 */
export function architectureToResources(plan: ArchitecturePlan): NormalizedResource[] {
  return plan.components.map((c) => {
    const attributes: Record<string, unknown> = {};
    switch (c.service) {
      case "aws_instance":
        if (c.instanceType) attributes.instance_type = c.instanceType;
        if (c.storageGb !== undefined) attributes.root_block_device = { volume_size: c.storageGb };
        break;
      case "aws_ebs_volume":
        if (c.storageGb !== undefined) attributes.size = c.storageGb;
        break;
      case "aws_db_instance":
        if (c.instanceType) attributes.instance_class = c.instanceType;
        if (c.storageGb !== undefined) attributes.allocated_storage = c.storageGb;
        attributes.multi_az = c.multiAz ?? false;
        break;
      case "aws_cloudwatch_log_group":
        if (c.logRetentionDays !== undefined) attributes.retention_in_days = c.logRetentionDays;
        break;
      case "aws_eip":
        // A design-level EIP is always intended to be attached; the
        // unattached-EIP check only becomes meaningful on real plans.
        attributes.instance = "planned";
        break;
    }
    return { type: c.service, name: c.name, attributes };
  });
}
