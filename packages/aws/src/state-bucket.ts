import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  PutBucketTaggingCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import type { AwsCredentialIdentity } from "@smithy/types";

export function stateBucketName(accountId: string, region: string): string {
  return `autoinfra-tfstate-${accountId}-${region}`;
}

/**
 * Sec. 3.3: one Terraform state bucket per AWS account + region, created
 * with the SDK (not Terraform) before the first apply. Versioned, encrypted,
 * private. Locking uses S3-native lockfiles (use_lockfile), so no DynamoDB
 * lock table. Idempotent: an existing bucket we own is re-hardened, which
 * also repairs settings someone changed by hand.
 */
export async function ensureStateBucket(
  credentials: AwsCredentialIdentity,
  region: string,
  accountId: string,
): Promise<string> {
  const s3 = new S3Client({ region, credentials });
  const Bucket = stateBucketName(accountId, region);

  let exists = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket, ExpectedBucketOwner: accountId }));
    exists = true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 403) {
      throw new Error(`State bucket ${Bucket} exists but is not owned by account ${accountId}.`);
    }
    if (status !== 404) throw err;
  }

  if (!exists) {
    await s3.send(
      new CreateBucketCommand({
        Bucket,
        ...(region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint },
            }),
      }),
    );
  }

  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    }),
  );
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket,
      Tagging: {
        TagSet: [
          { Key: "autoinfra:managed-by", Value: "autoinfra" },
          { Key: "autoinfra:purpose", Value: "terraform-state" },
        ],
      },
    }),
  );
  return Bucket;
}
