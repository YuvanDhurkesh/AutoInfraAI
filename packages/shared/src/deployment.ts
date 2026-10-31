import { z } from "zod";
import { DeploymentPattern, DeploymentStatus, FreeTierMode } from "./enums.js";

/** v1 is GitHub-only (Sec. 10) -- also our SSRF boundary for cloning. */
export const GITHUB_REPO_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/;

export const CreateDeploymentInput = z.object({
  repoUrl: z.string().regex(GITHUB_REPO_URL, "must be a https://github.com/<owner>/<repo> URL"),
  // Empty or left out: the repository's own default branch (main, master,
  // trunk...), found when it's cloned.
  branch: z.preprocess(
    (b) => (typeof b === "string" && b.trim() === "" ? undefined : b),
    z
      .string()
      .regex(/^[A-Za-z0-9._/-]+$/, "invalid branch name")
      .refine((b) => !b.startsWith("-"), "invalid branch name")
      .optional(),
  ),
  // Relative path inside the repo; ".." segments and absolute paths would
  // let a scan escape the clone directory.
  subdir: z
    .string()
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "must be a relative path like apps/web")
    .refine((s) => !s.split("/").includes(".."), "must not contain '..'")
    .optional(),
  awsConnectionId: z.string().uuid(),
  /** Omitted: the owner's default from settings. */
  freeTierMode: FreeTierMode.optional(),
  allowRds: z.boolean().default(false),
  /** The app's database is hosted outside AWS; the user enters its connection settings. */
  externalDatabase: z.boolean().default(false),
});
export type CreateDeploymentInput = z.infer<typeof CreateDeploymentInput>;

export const DeploymentSummary = z.object({
  id: z.string().uuid(),
  repoUrl: z.string().url(),
  branch: z.string(),
  pattern: DeploymentPattern.nullable(),
  status: DeploymentStatus,
  region: z.string().nullable(),
  liveUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeploymentSummary = z.infer<typeof DeploymentSummary>;
