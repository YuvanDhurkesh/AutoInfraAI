import { z } from "zod";
import { AccountRegime } from "./enums.js";

export const CreateAwsConnectionInput = z.object({
  region: z.string().min(1).optional(),
});
export type CreateAwsConnectionInput = z.infer<typeof CreateAwsConnectionInput>;

const ROLE_ARN_PATTERN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;

export const SetAwsConnectionRoleInput = z.object({
  roleArn: z
    .string()
    .regex(
      ROLE_ARN_PATTERN,
      "must be a role ARN, e.g. arn:aws:iam::123456789012:role/AutoInfraDeployRole",
    ),
  region: z.string().min(1).optional(),
});
export type SetAwsConnectionRoleInput = z.infer<typeof SetAwsConnectionRoleInput>;

export const SetAwsConnectionRegimeInput = z.object({
  regime: AccountRegime,
});
export type SetAwsConnectionRegimeInput = z.infer<typeof SetAwsConnectionRegimeInput>;

export const AwsConnectionSummary = z.object({
  id: z.string().uuid(),
  region: z.string(),
  roleArn: z.string().nullable(),
  externalId: z.string(),
  accountRegime: AccountRegime.nullable(),
  regimeSource: z.enum(["freetier-api", "user"]).nullable(),
  verifiedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type AwsConnectionSummary = z.infer<typeof AwsConnectionSummary>;
