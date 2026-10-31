import { z } from "zod";
import { DeploymentPattern } from "./enums.js";

/**
 * Gemini's proposed architecture (Milestone 5), validated server-side before
 * any Terraform is generated from it. `service` is the Terraform resource
 * type so the server can run the Free Tier evaluator against the plan
 * itself, never against the model's own assessment.
 */
export const ArchitectureComponent = z.object({
  service: z.string().regex(/^aws_[a-z0-9_]+$/, "must be a Terraform aws_* resource type"),
  name: z.string(),
  purpose: z.string(),
  instanceType: z.string().optional(),
  storageGb: z.number().nonnegative().optional(),
  multiAz: z.boolean().optional(),
  logRetentionDays: z.number().int().nonnegative().optional(),
});
export type ArchitectureComponent = z.infer<typeof ArchitectureComponent>;

export const ArchitecturePlan = z.object({
  pattern: DeploymentPattern,
  summary: z.string(),
  components: z.array(ArchitectureComponent).min(1),
  routing: z.object({
    apiPathPrefix: z.string(),
  }),
  envMapping: z.array(z.object({ name: z.string(), isSecret: z.boolean() })),
  risks: z.array(z.string()),
  assumptions: z.array(z.string()),
  mermaidDiagram: z.string(),
  draftFreeTierAssessment: z.string(),
});
export type ArchitecturePlan = z.infer<typeof ArchitecturePlan>;
