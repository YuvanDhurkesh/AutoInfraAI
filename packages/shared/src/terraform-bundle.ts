import { z } from "zod";

/**
 * LLM-generated files are written to a worker temp dir, so paths are an
 * allowlist: top-level *.tf, buildspec.yml, and a handful of app support
 * files under app/. No "..", no absolute paths, no dotfiles.
 */
export const TERRAFORM_FILE_PATH =
  /^(?:[a-z0-9_-]+\.tf|buildspec\.yml|app\/(?:Dockerfile|docker-compose\.yml|Caddyfile|run\.sh|bootstrap\.sh|setup\.sh))$/;

export const MAX_TERRAFORM_FILES = 40;
export const MAX_TERRAFORM_FILE_BYTES = 100_000;

export const TerraformFile = z.object({
  path: z.string().regex(TERRAFORM_FILE_PATH, "path not allowed"),
  content: z.string().max(MAX_TERRAFORM_FILE_BYTES),
});
export type TerraformFile = z.infer<typeof TerraformFile>;

export const TerraformBundle = z.object({
  files: z
    .array(TerraformFile)
    .min(1)
    .max(MAX_TERRAFORM_FILES)
    .refine(
      (files) => new Set(files.map((f) => f.path)).size === files.length,
      "duplicate file paths",
    ),
});
export type TerraformBundle = z.infer<typeof TerraformBundle>;

export const GateName = z.enum([
  "static",
  "fmt",
  "init",
  "validate",
  "tflint",
  "trivy",
  "plan",
  "security_policy",
  "free_tier_policy",
]);
export type GateName = z.infer<typeof GateName>;

export const GateResult = z.object({
  gate: GateName,
  status: z.enum(["passed", "failed", "skipped"]),
  errors: z.array(z.string()),
  notes: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative(),
  /** false: a failure no edit to the files can fix (the network, a crashed tool) -- never sent to the model. */
  repairable: z.boolean().optional(),
});
export type GateResult = z.infer<typeof GateResult>;

export const PlanResourceChange = z.object({
  address: z.string(),
  type: z.string(),
  action: z.enum(["create", "update", "delete", "replace", "no-op", "read"]),
  dataBearing: z.boolean(),
});
export type PlanResourceChange = z.infer<typeof PlanResourceChange>;

export const PlanSummary = z.object({
  adds: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  destroys: z.number().int().nonnegative(),
  replaces: z.number().int().nonnegative(),
  resources: z.array(PlanResourceChange),
  dataBearingDestroys: z.array(z.string()),
});
export type PlanSummary = z.infer<typeof PlanSummary>;
