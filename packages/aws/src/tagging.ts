import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import type { AwsCredentialIdentity } from "@smithy/types";

/**
 * ARNs of resources still carrying a tag -- Destroy's leftover check. Every
 * resource AutoInfra creates gets "autoinfra:deployment-id" via the
 * provider's default_tags. CloudFront is global and reported in us-east-1.
 */
export async function findTaggedResources(
  credentials: AwsCredentialIdentity,
  regions: string[],
  tagKey: string,
  tagValue: string,
): Promise<string[]> {
  const arns = new Set<string>();
  for (const region of new Set(regions)) {
    const client = new ResourceGroupsTaggingAPIClient({ region, credentials });
    let PaginationToken: string | undefined;
    do {
      const page = await client.send(
        new GetResourcesCommand({
          TagFilters: [{ Key: tagKey, Values: [tagValue] }],
          PaginationToken,
        }),
      );
      for (const r of page.ResourceTagMappingList ?? []) if (r.ResourceARN) arns.add(r.ResourceARN);
      PaginationToken = page.PaginationToken || undefined;
    } while (PaginationToken);
  }
  return withoutDeletedEc2(credentials, [...arns]);
}

/**
 * The tagging API keeps listing deleted EC2 items for a while (terminated
 * instances for ~1 hour, deleted volumes and security-group rules). Checks
 * each EC2 ARN against EC2 itself and drops the ones that are gone; other
 * ARNs are kept as-is.
 */
export async function withoutDeletedEc2(
  credentials: AwsCredentialIdentity,
  arns: string[],
): Promise<string[]> {
  const kept: string[] = [];
  for (const arn of arns) {
    const match = arn.match(
      /^arn:aws:ec2:([\w-]+):\d+:(instance|volume|security-group-rule)\/(.+)$/,
    );
    if (!match) {
      kept.push(arn);
      continue;
    }
    const [, region, kind, id] = match;
    const ec2 = new EC2Client({ region, credentials });
    try {
      if (kind === "instance") {
        const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id!] }));
        const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name;
        if (state && state !== "terminated") kept.push(arn);
      } else if (kind === "volume") {
        await ec2.send(new DescribeVolumesCommand({ VolumeIds: [id!] }));
        kept.push(arn);
      } else {
        await ec2.send(new DescribeSecurityGroupRulesCommand({ SecurityGroupRuleIds: [id!] }));
        kept.push(arn);
      }
    } catch (err) {
      // NotFound means it's really gone; anything else, keep reporting it.
      if (!/NotFound/.test((err as { name?: string }).name ?? "")) kept.push(arn);
    }
  }
  return kept;
}
