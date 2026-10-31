import { z } from "zod";
import { FreeTierFit } from "./enums.js";

/**
 * Authoritative Free Tier assessment computed server-side (packages/free-tier-policy,
 * Milestone 3) for an ArchitecturePlan or a Terraform plan. Never trust the LLM's own
 * assessment -- this is always recomputed independently.
 */
export const FreeTierResourceNote = z.object({
  service: z.string(),
  resource: z.string(),
  eligible: z.boolean(),
  notes: z.string(),
});
export type FreeTierResourceNote = z.infer<typeof FreeTierResourceNote>;

export const FreeTierUsageProjection = z.object({
  ec2Hours: z.number().nonnegative().default(0),
  publicIPv4Count: z.number().int().nonnegative().default(0),
  ebsGb: z.number().nonnegative().default(0),
  s3Gb: z.number().nonnegative().default(0),
  rdsHours: z.number().nonnegative().default(0),
  rdsStorageGb: z.number().nonnegative().default(0),
  lambdaRequestsPerMonth: z.number().nonnegative().default(0),
  lambdaGbSeconds: z.number().nonnegative().default(0),
  cloudFrontGbOut: z.number().nonnegative().default(0),
  cloudFrontRequests: z.number().nonnegative().default(0),
  cloudWatchLogsGb: z.number().nonnegative().default(0),
  ecrGb: z.number().nonnegative().default(0),
  codeBuildMinutes: z.number().nonnegative().default(0),
});
export type FreeTierUsageProjection = z.infer<typeof FreeTierUsageProjection>;

export const FreeTierReport = z.object({
  fit: FreeTierFit,
  resources: z.array(FreeTierResourceNote),
  usage: FreeTierUsageProjection,
  warnings: z.array(z.string()).default([]),
  denyListViolations: z.array(z.string()).default([]),
  estimatedMonthlyCostUsd: z.number().nonnegative().default(0),
});
export type FreeTierReport = z.infer<typeof FreeTierReport>;
