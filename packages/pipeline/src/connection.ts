import { Prisma, type AwsConnection, type PrismaClient } from "@prisma/client";
import { DEPLOY_ROLE_TEMPLATE_VERSION } from "@autoinfra/terraform-reference";
import type {
  assumeDeployRole,
  getCallerIdentity,
  getAccountPlanState,
  getFreeTierUsage,
  listFreeTierEligibleInstanceTypes,
} from "@autoinfra/aws";

export interface ConnectionAws {
  assumeDeployRole: typeof assumeDeployRole;
  getCallerIdentity: typeof getCallerIdentity;
  getAccountPlanState: typeof getAccountPlanState;
  getFreeTierUsage: typeof getFreeTierUsage;
  listFreeTierEligibleInstanceTypes: typeof listFreeTierEligibleInstanceTypes;
}

export class VerifyError extends Error {}

export interface VerifyResult {
  connection: AwsConnection;
  needsManualRegime: boolean;
  eligibleInstanceTypes: string[];
}

/**
 * Assumes the role with the connection's ExternalId, then detects the Free
 * Tier regime (Sec. 2.1), usage, and eligible instance types. Retries the
 * assume step: a freshly created role takes a few seconds to become
 * assumable, and the CloudFormation callback fires right at creation.
 */
export async function verifyConnection(
  prisma: PrismaClient,
  aws: ConnectionAws,
  connection: AwsConnection,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<VerifyResult> {
  if (!connection.roleArn)
    throw new VerifyError("No role has been registered for this connection yet.");
  const attempts = opts.attempts ?? 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let credentials;
  let lastError = "";
  for (let i = 1; i <= attempts && !credentials; i++) {
    try {
      credentials = await aws.assumeDeployRole({
        roleArn: connection.roleArn,
        externalId: connection.externalId,
        region: connection.region,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (i < attempts) await sleep(5000);
    }
  }
  if (!credentials) throw new VerifyError(`Could not assume ${connection.roleArn}: ${lastError}`);

  const identity = await aws.getCallerIdentity(credentials, connection.region);
  const planState = await aws.getAccountPlanState(credentials, connection.region);
  const usage = await aws.getFreeTierUsage(credentials, connection.region);
  const eligibleInstanceTypes = await aws
    .listFreeTierEligibleInstanceTypes(credentials, connection.region)
    .catch(() => [] as string[]);

  // AWS SDK responses can contain Date objects, which aren't valid Prisma
  // Json input -- round-trip through JSON (Dates become ISO strings).
  const snapshot = JSON.parse(
    JSON.stringify({
      source: planState.regime ? planState.source : null,
      accountId: identity.accountId,
      planState: planState.raw,
      usage: usage.available ? usage.usages : null,
      eligibleInstanceTypes,
      checkedAt: new Date().toISOString(),
    }),
  ) as Prisma.InputJsonValue;

  const updated = await prisma.awsConnection.update({
    where: { id: connection.id },
    data: {
      verifiedAt: new Date(),
      accountRegime: planState.regime ?? undefined,
      planStateJson: snapshot,
    },
  });
  return {
    connection: updated,
    needsManualRegime: planState.regime === null,
    eligibleInstanceTypes,
  };
}

interface CustomResourceRequest {
  RequestType: "Create" | "Update" | "Delete";
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties?: {
    ConnectionId?: string;
    ExternalId?: string;
    RoleArn?: string;
    TemplateVersion?: string;
  };
}

export interface RegistrationDeps {
  prisma: PrismaClient;
  aws: ConnectionAws;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;

/**
 * Handles the template's custom-resource callback (SNS -> SQS). The message
 * itself is untrusted -- anyone can publish to the topic -- so a
 * registration only succeeds if it names an existing pending connection, its
 * ExternalId matches, and the platform can actually assume the role with it.
 * The answer goes back to CloudFormation: FAILED rolls the user's stack back
 * (removing the role) with the reason shown in their console.
 */
const CFN_RESPONSE_HOST =
  /^cloudformation-custom-resource-response(-[a-z0-9]+)?\.s3([.-][a-z0-9-]+)?\.amazonaws\.com(\.cn)?$/;

export function isCloudFormationResponseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      CFN_RESPONSE_HOST.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export async function handleRegistration(
  deps: RegistrationDeps,
  sqsBody: string,
): Promise<{ status: "SUCCESS" | "FAILED"; reason: string }> {
  let request: CustomResourceRequest;
  try {
    const envelope = JSON.parse(sqsBody) as { Message?: string };
    request = JSON.parse(envelope.Message ?? sqsBody) as CustomResourceRequest;
  } catch {
    return { status: "FAILED", reason: "Unparseable message (ignored)" };
  }
  if (!request.ResponseURL || !request.StackId || !request.RequestId) {
    return { status: "FAILED", reason: "Not a CloudFormation custom resource request (ignored)" };
  }
  // The topic accepts publishes from any AWS account (it has to: the stacks
  // run in users' accounts), so the URL we PUT to is attacker-controlled
  // until proven otherwise. CloudFormation only ever hands out presigned S3
  // URLs on its own response buckets.
  if (!isCloudFormationResponseUrl(request.ResponseURL)) {
    return {
      status: "FAILED",
      reason: "ResponseURL is not a CloudFormation response URL (ignored)",
    };
  }

  const props = request.ResourceProperties ?? {};
  let status: "SUCCESS" | "FAILED" = "SUCCESS";
  let reason = "AutoInfra connected.";

  if (request.RequestType === "Delete") {
    // Never block the user from deleting their own stack; just forget the role.
    const connection = props.ConnectionId
      ? await deps.prisma.awsConnection
          .findUnique({ where: { id: props.ConnectionId } })
          .catch(() => null)
      : null;
    if (
      connection &&
      connection.externalId === props.ExternalId &&
      connection.roleArn === props.RoleArn
    ) {
      await deps.prisma.awsConnection.update({
        where: { id: connection.id },
        data: { roleArn: null, verifiedAt: null },
      });
    }
    reason = "AutoInfra disconnected.";
  } else {
    const connection = props.ConnectionId
      ? await deps.prisma.awsConnection
          .findUnique({ where: { id: props.ConnectionId } })
          .catch(() => null)
      : null;
    if (!connection || !props.ExternalId || connection.externalId !== props.ExternalId) {
      status = "FAILED";
      reason =
        "This stack doesn't match a pending AutoInfra connection. Start again from AutoInfra.";
    } else if (!props.RoleArn || !ROLE_ARN.test(props.RoleArn)) {
      status = "FAILED";
      reason = "The stack did not report a valid role ARN.";
    } else {
      // An Update is the user applying a newer template to a working role:
      // if it can't be verified, keep the connection as it was.
      const previous = { roleArn: connection.roleArn, verifiedAt: connection.verifiedAt };
      const pending = await deps.prisma.awsConnection.update({
        where: { id: connection.id },
        data: {
          roleArn: props.RoleArn,
          verifiedAt: null,
          templateVersion: Number(props.TemplateVersion) || null,
        },
      });
      try {
        await verifyConnection(deps.prisma, deps.aws, pending, { attempts: 8, sleep: deps.sleep });
      } catch (err) {
        status = "FAILED";
        reason =
          `AutoInfra could not use the new role: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            500,
          );
        await deps.prisma.awsConnection.update({
          where: { id: connection.id },
          data:
            request.RequestType === "Update"
              ? { ...previous, templateVersion: connection.templateVersion }
              : { roleArn: null },
        });
      }
    }
  }

  // CloudFormation requires an empty content-type on the presigned PUT.
  const body = JSON.stringify({
    Status: status,
    Reason: reason,
    PhysicalResourceId:
      request.PhysicalResourceId ?? `autoinfra-${props.ConnectionId ?? "unknown"}`,
    StackId: request.StackId,
    RequestId: request.RequestId,
    LogicalResourceId: request.LogicalResourceId,
  });
  await deps.fetch(request.ResponseURL, { method: "PUT", headers: { "content-type": "" }, body });
  return { status, reason };
}

export function toConnectionSummary(connection: AwsConnection) {
  const planState = connection.planStateJson as { source?: "freetier-api" | "user" } | null;
  return {
    id: connection.id,
    region: connection.region,
    roleArn: connection.roleArn,
    externalId: connection.externalId,
    accountRegime: connection.accountRegime,
    regimeSource: planState?.source ?? null,
    verifiedAt: connection.verifiedAt?.toISOString() ?? null,
    templateVersion: connection.templateVersion,
    // A connected role on an older permission set: deploys may hit
    // AccessDenied until the user updates the stack.
    needsPermissionUpdate:
      !!connection.roleArn && (connection.templateVersion ?? 1) < DEPLOY_ROLE_TEMPLATE_VERSION,
    freePlan: freePlanOf(connection),
    createdAt: connection.createdAt.toISOString(),
  };
}

/**
 * New-model Free plan accounts close automatically when the plan ends unless
 * the owner upgrades (AutoInfra never does that for them). What AWS reported
 * at the last verification, so the UI can warn well ahead of the date.
 */
function freePlanOf(connection: AwsConnection) {
  if (connection.accountRegime !== "free_plan") return null;
  const snapshot = connection.planStateJson as {
    planState?: {
      accountPlanStatus?: string;
      accountPlanExpirationDate?: string;
      accountPlanRemainingCredits?: { amount?: number; unit?: string };
    };
    checkedAt?: string;
  } | null;
  const state = snapshot?.planState;
  return {
    status: state?.accountPlanStatus ?? null,
    expiresAt: state?.accountPlanExpirationDate ?? null,
    remainingCredits:
      typeof state?.accountPlanRemainingCredits?.amount === "number"
        ? {
            amount: state.accountPlanRemainingCredits.amount,
            unit: state.accountPlanRemainingCredits.unit ?? "USD",
          }
        : null,
    checkedAt: snapshot?.checkedAt ?? null,
  };
}
