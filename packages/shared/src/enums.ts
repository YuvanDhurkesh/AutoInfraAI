import { z } from "zod";

export const DeploymentPattern = z.enum(["F1", "F2", "F3"]);
export type DeploymentPattern = z.infer<typeof DeploymentPattern>;

export const FreeTierMode = z.enum(["strict", "flexible"]);
export type FreeTierMode = z.infer<typeof FreeTierMode>;

export const AccountRegime = z.enum(["legacy_12mo", "free_plan", "paid_plan"]);
export type AccountRegime = z.infer<typeof AccountRegime>;

export const DeploymentStatus = z.enum([
  "queued",
  "analyzing",
  "designing",
  "generating",
  "validating",
  "awaiting_approval",
  "applying",
  "building",
  "deploying",
  "health_checking",
  "live",
  "updating",
  "destroying",
  "destroyed",
  "rolled_back",
  "failed",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const RevisionAction = z.enum(["initial", "change", "rollback", "redeploy"]);
export type RevisionAction = z.infer<typeof RevisionAction>;

export const FreeTierFit = z.enum(["within_limits", "near_limit", "exceeds"]);
export type FreeTierFit = z.infer<typeof FreeTierFit>;
