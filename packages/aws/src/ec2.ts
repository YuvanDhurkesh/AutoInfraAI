import { EC2Client, DescribeInstanceTypesCommand } from "@aws-sdk/client-ec2";
import type { AwsCredentialIdentity } from "@smithy/types";

/**
 * Looks up Free-Tier-eligible instance types for the account/region instead of
 * hardcoding "t2.micro"/"t3.micro" (Sec. 2.1 -- eligibility varies by account
 * and region, e.g. Graviton-only regions offer t4g.micro instead).
 */
export async function listFreeTierEligibleInstanceTypes(
  credentials: AwsCredentialIdentity,
  region: string,
): Promise<string[]> {
  const client = new EC2Client({ region, credentials });
  const types: string[] = [];
  let nextToken: string | undefined;

  do {
    const result = await client.send(
      new DescribeInstanceTypesCommand({
        Filters: [{ Name: "free-tier-eligible", Values: ["true"] }],
        NextToken: nextToken,
      }),
    );
    for (const info of result.InstanceTypes ?? []) {
      if (info.InstanceType) types.push(info.InstanceType);
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return types;
}
