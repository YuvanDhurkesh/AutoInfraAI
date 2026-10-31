import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DenyListEntry {
  code: string;
  resourceTypes: string[];
  reason: string;
  /** If every listed attribute matches, the resource is denied. Absent
   * means "deny whenever this resource type appears at all". A value of
   * `null` means "the attribute is unset/null on the resource". */
  attributeDeny?: Record<string, unknown>;
}

export interface FreeTierPolicy {
  lastVerified: string;
  sourceUrls: string[];
  notes: string;
  regimes: {
    legacy_12mo: {
      label: string;
      durationMonths: number;
      ec2: { hoursPerMonth: number };
      rds: { hoursPerMonth: number; storageGb: number; multiAz: boolean };
      s3: { storageGb: number; getRequestsPerMonth: number; putRequestsPerMonth: number };
      ebsGb: number;
      publicIpv4HoursPerMonth: number;
    };
    free_plan: {
      label: string;
      creditUsd: number;
      durationMonths: number;
      autoClosesIfNotUpgraded: boolean;
    };
    paid_plan: { label: string };
  };
  alwaysFree: {
    lambda: { requestsPerMonth: number; gbSeconds: number };
    dynamodb: { storageGb: number; readCapacityUnits: number; writeCapacityUnits: number };
    cloudfront: { dataTransferOutGb: number; requestsPerMonth: number };
  };
  lambdaPackageSizeLimitMb: number;
  cloudFrontOriginResponseTimeoutSeconds: number;
  limits: {
    ebsMaxTotalGb: number;
    rdsMaxStorageGb: number;
    logRetentionDaysRequired: number;
    maxAlwaysOnEc2PerAwsAccount: number;
    maxPublicIpv4PerDeployment: number;
    ecrMaxImagesPerRepo: number;
  };
  denyList: DenyListEntry[];
}

const policyPath = path.resolve(fileURLToPath(new URL("../policy.json", import.meta.url)));

export const policy: FreeTierPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
