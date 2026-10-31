import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutObjectCommand,
  GetObjectCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SNSClient,
  CreateTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

/**
 * AutoInfra's own (platform-account) resources for the one-click "Connect
 * AWS" flow: a private bucket holding the deploy-role template (served to
 * CloudFormation via a short-lived presigned URL), and an SNS topic + SQS
 * queue that receive the template's custom-resource callback when the user's
 * stack creates the role. The worker long-polls SQS, so AWS never needs to
 * reach the platform -- this works for a local-only platform too.
 */
export interface PlatformResources {
  region: string;
  accountId: string;
  bucket: string;
  topicArn: string;
  queueUrl: string;
}

export const REGISTRATION_TOPIC = "autoinfra-registrations";
export const REGISTRATION_QUEUE = "autoinfra-registrations";
export const TEMPLATE_KEY = "templates/autoinfra-deploy-role.yaml";

export function platformBucketName(accountId: string, region: string) {
  return `autoinfra-platform-${accountId}-${region}`;
}

/** Idempotent: every call re-applies the same configuration. Uses the platform's ambient credentials. */
export async function ensurePlatformResources(
  region: string,
  accountId: string,
): Promise<PlatformResources> {
  const s3 = new S3Client({ region });
  const sns = new SNSClient({ region });
  const sqs = new SQSClient({ region });
  const bucket = platformBucketName(accountId, region);

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: accountId }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) throw err;
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
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
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    }),
  );

  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: REGISTRATION_TOPIC }));
  if (!TopicArn) throw new Error("SNS did not return a topic ARN");
  // Any account's CloudFormation must be able to deliver its stack's
  // callback. Messages are untrusted: a registration only counts once the
  // platform has assumed the named role with the connection's ExternalId.
  await sns.send(
    new SetTopicAttributesCommand({
      TopicArn,
      AttributeName: "Policy",
      AttributeValue: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "CloudFormationCustomResources",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: "sns:Publish",
            Resource: TopicArn,
          },
        ],
      }),
    }),
  );

  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: REGISTRATION_QUEUE,
      Attributes: {
        MessageRetentionPeriod: "86400",
        ReceiveMessageWaitTimeSeconds: "20",
        SqsManagedSseEnabled: "true",
      },
    }),
  );
  if (!QueueUrl) throw new Error("SQS did not return a queue URL");
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const queueArn = Attributes?.QueueArn;
  if (!queueArn) throw new Error("SQS did not return a queue ARN");
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "sns.amazonaws.com" },
              Action: "sqs:SendMessage",
              Resource: queueArn,
              Condition: { ArnEquals: { "aws:SourceArn": TopicArn } },
            },
          ],
        }),
      },
    }),
  );
  await sns.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: queueArn }));

  return { region, accountId, bucket, topicArn: TopicArn, queueUrl: QueueUrl };
}

export async function publishTemplate(
  platform: PlatformResources,
  template: string,
): Promise<string> {
  const s3 = new S3Client({ region: platform.region });
  await s3.send(
    new PutObjectCommand({
      Bucket: platform.bucket,
      Key: TEMPLATE_KEY,
      Body: template,
      ContentType: "text/yaml",
      ServerSideEncryption: "AES256",
    }),
  );
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: platform.bucket, Key: TEMPLATE_KEY }), {
    expiresIn: 3600,
  });
}

/** AWS console "quick create" link: the user only ticks the IAM acknowledgement and clicks Create stack. */
export function quickCreateUrl(opts: {
  region: string;
  templateUrl: string;
  stackName: string;
  parameters: Record<string, string>;
}): string {
  const query = new URLSearchParams({ templateURL: opts.templateUrl, stackName: opts.stackName });
  for (const [k, v] of Object.entries(opts.parameters)) query.set(`param_${k}`, v);
  return `https://${opts.region}.console.aws.amazon.com/cloudformation/home?region=${opts.region}#/stacks/quickcreate?${query.toString()}`;
}

export interface QueueMessage {
  receiptHandle: string;
  body: string;
}

export async function receiveRegistrations(
  region: string,
  queueUrl: string,
): Promise<QueueMessage[]> {
  const sqs = new SQSClient({ region });
  const res = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 5, WaitTimeSeconds: 20 }),
  );
  return (res.Messages ?? []).flatMap((m) =>
    m.ReceiptHandle && m.Body ? [{ receiptHandle: m.ReceiptHandle, body: m.Body }] : [],
  );
}

export async function deleteRegistration(region: string, queueUrl: string, receiptHandle: string) {
  const sqs = new SQSClient({ region });
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}
