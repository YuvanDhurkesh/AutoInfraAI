import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity } from "@smithy/types";

export interface AssumeDeployRoleInput {
  roleArn: string;
  externalId: string;
  region: string;
  sessionName?: string;
  durationSeconds?: number;
}

/**
 * Short-lived credentials for the user's cross-account deploy role. Never
 * persisted -- obtained fresh per job (Sec. 3.1 of the brief).
 */
export async function assumeDeployRole(
  input: AssumeDeployRoleInput,
): Promise<AwsCredentialIdentity & { expiration?: Date }> {
  const client = new STSClient({ region: input.region });
  const result = await client.send(
    new AssumeRoleCommand({
      RoleArn: input.roleArn,
      ExternalId: input.externalId,
      RoleSessionName: input.sessionName ?? "autoinfra-verify",
      DurationSeconds: input.durationSeconds ?? 900,
    }),
  );

  const creds = result.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error("sts:AssumeRole returned no usable credentials");
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiration: creds.Expiration,
  };
}

export async function getCallerIdentity(credentials: AwsCredentialIdentity, region: string) {
  const client = new STSClient({ region, credentials });
  const result = await client.send(new GetCallerIdentityCommand({}));
  return { accountId: result.Account, arn: result.Arn, userId: result.UserId };
}

/**
 * The platform's own AWS identity, resolved from the ambient credential chain
 * (env vars / shared config / instance profile -- whatever the api/worker
 * process is running as), never hardcoded. Used as the trust policy
 * Principal in the generated deploy-role CloudFormation template.
 */
export async function getPlatformAccountId(region: string): Promise<string> {
  const client = new STSClient({ region });
  const result = await client.send(new GetCallerIdentityCommand({}));
  if (!result.Account) {
    throw new Error("Unable to resolve the platform's own AWS account id from ambient credentials");
  }
  return result.Account;
}
