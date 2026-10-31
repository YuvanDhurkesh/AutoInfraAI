import type { NormalizedResource } from "./types.js";
import { calculateTotalEbsGb } from "./structural-checks.js";

const HOURS_PER_MONTH = 730; // 365.25 * 24 / 12, the standard AWS convention

/**
 * Only projects what's statically derivable from a Terraform plan (resource
 * counts and sizes). Traffic-dependent usage -- Lambda invocations, S3
 * requests, CloudFront transfer, log volume -- can't be known before the
 * app actually runs, so those fields stay 0 here; real usage is tracked
 * post-deployment via the free-tier ledger and the AWS Free Tier API
 * (Sec. 2.4), not guessed at plan time.
 */
export function projectUsage(resources: NormalizedResource[]) {
  const ec2Count = resources.filter((r) => r.type === "aws_instance").length;
  const rdsInstances = resources.filter((r) => r.type === "aws_db_instance");
  const rdsStorageGb = rdsInstances.reduce((sum, r) => {
    const value = r.attributes.allocated_storage;
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  const publicIPv4Count =
    resources.filter((r) => r.type === "aws_eip").length +
    resources.filter(
      (r) => r.type === "aws_instance" && r.attributes.associate_public_ip_address === true,
    ).length;

  return {
    ec2Hours: ec2Count * HOURS_PER_MONTH,
    publicIPv4Count,
    ebsGb: calculateTotalEbsGb(resources),
    s3Gb: 0,
    rdsHours: rdsInstances.length * HOURS_PER_MONTH,
    rdsStorageGb,
    lambdaRequestsPerMonth: 0,
    lambdaGbSeconds: 0,
    cloudFrontGbOut: 0,
    cloudFrontRequests: 0,
    cloudWatchLogsGb: 0,
    ecrGb: 0,
    codeBuildMinutes: 0,
  };
}
