import {
  SSMClient,
  PutParameterCommand,
  DeleteParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
} from "@aws-sdk/client-ssm";
import type { AwsCredentialIdentity } from "@smithy/types";

export function parameterPath(shortId: string, name: string): string {
  return `/autoinfra/${shortId}/${name}`;
}

/**
 * App env vars and secrets live only in the user's account (Sec. 3.2):
 * secrets as SecureString with the AWS-managed key (never a customer-managed
 * KMS key, never Secrets Manager). AutoInfra stores names, never values.
 */
export async function putAppParameter(opts: {
  credentials: AwsCredentialIdentity;
  region: string;
  shortId: string;
  deploymentId: string;
  name: string;
  value: string;
  isSecret: boolean;
}): Promise<string> {
  const ssm = new SSMClient({ region: opts.region, credentials: opts.credentials });
  const Name = parameterPath(opts.shortId, opts.name);
  await ssm.send(
    new PutParameterCommand({
      Name,
      Value: opts.value,
      Type: opts.isSecret ? "SecureString" : "String",
      Tier: "Standard",
      Overwrite: true,
    }),
  );
  return Name;
}

/** Deletes every parameter under a path (Destroy: env vars AutoInfra wrote outside Terraform). */
export async function deleteParametersByPath(
  credentials: AwsCredentialIdentity,
  region: string,
  pathPrefix: string,
): Promise<string[]> {
  const ssm = new SSMClient({ region, credentials });
  const names: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await ssm.send(
      new GetParametersByPathCommand({ Path: pathPrefix, Recursive: true, NextToken }),
    );
    names.push(...(page.Parameters ?? []).map((p) => p.Name!).filter(Boolean));
    NextToken = page.NextToken;
  } while (NextToken);
  for (const name of names) await deleteAppParameter(credentials, region, name);
  return names;
}

export async function deleteAppParameter(
  credentials: AwsCredentialIdentity,
  region: string,
  path: string,
) {
  const ssm = new SSMClient({ region, credentials });
  try {
    await ssm.send(new DeleteParameterCommand({ Name: path }));
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
  }
}
