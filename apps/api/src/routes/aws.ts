import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CreateAwsConnectionInput,
  SetAwsConnectionRoleInput,
  SetAwsConnectionRegimeInput,
} from "@autoinfra/shared";
import {
  assumeDeployRole,
  getCallerIdentity,
  getPlatformAccountId,
  listFreeTierEligibleInstanceTypes,
  getAccountPlanState,
  getFreeTierUsage,
} from "@autoinfra/aws";
import { buildDeployRoleTemplate } from "@autoinfra/terraform-reference";
import { toConnectionSummary, verifyConnection, VerifyError } from "@autoinfra/pipeline";
import type { AppDeps } from "../app.js";
import { requireAuth } from "../middleware/require-auth.js";
import type { Env } from "../env.js";
import type { Limits } from "../lib/rate-limit.js";

const aws = {
  assumeDeployRole,
  getCallerIdentity,
  getAccountPlanState,
  getFreeTierUsage,
  listFreeTierEligibleInstanceTypes,
};

export function registerAwsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  env: Env,
  deps: AppDeps,
  limits: Limits,
) {
  /** One-click connect: a CloudFormation quick-create link whose stack reports back by itself. */
  async function connectLink(connection: { id: string; externalId: string }) {
    try {
      return { quickCreateUrl: await deps.prepareConnect(connection), connectError: null };
    } catch (err) {
      app.log.warn({ err }, "one-click connect unavailable");
      return {
        quickCreateUrl: null,
        connectError:
          "One-click connect is unavailable on this AutoInfra server; use the manual steps.",
      };
    }
  }

  app.get("/aws/connections", { preHandler: requireAuth }, async (request) => {
    const connections = await prisma.awsConnection.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: "desc" },
    });
    return connections.map(toConnectionSummary);
  });

  app.post(
    "/aws/connections",
    { preHandler: [requireAuth, limits.awsConnect] },
    async (request, reply) => {
      const parsed = CreateAwsConnectionInput.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input", details: parsed.error.issues });
      }
      const connection = await prisma.awsConnection.create({
        data: {
          userId: request.user!.id,
          externalId: crypto.randomBytes(24).toString("hex"),
          region: parsed.data.region ?? env.AWS_REGION,
        },
      });
      await prisma.auditEvent.create({
        data: {
          userId: request.user!.id,
          action: "aws_connection_created",
          targetType: "aws_connection",
          targetId: connection.id,
          metadata: { region: connection.region },
        },
      });
      return reply
        .code(201)
        .send({ ...toConnectionSummary(connection), ...(await connectLink(connection)) });
    },
  );

  app.get("/aws/connections/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = await prisma.awsConnection.findFirst({
      where: { id, userId: request.user!.id },
    });
    if (!connection) return reply.code(404).send({ error: "not_found" });
    return toConnectionSummary(connection);
  });

  /** Fresh link (the presigned template URL inside it expires after an hour). */
  app.get(
    "/aws/connections/:id/connect-link",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const connection = await prisma.awsConnection.findFirst({
        where: { id, userId: request.user!.id },
      });
      if (!connection) return reply.code(404).send({ error: "not_found" });
      return connectLink(connection);
    },
  );

  /**
   * Steps to move an existing role stack onto the current permission set.
   * Updating it keeps the role, ExternalId and connection; the stack reports
   * the new version back, which clears needsPermissionUpdate.
   */
  app.get(
    "/aws/connections/:id/permission-update",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const connection = await prisma.awsConnection.findFirst({
        where: { id, userId: request.user!.id },
      });
      if (!connection) return reply.code(404).send({ error: "not_found" });
      let template;
      try {
        template = await deps.roleTemplateUrl();
      } catch (err) {
        request.log.warn({ err }, "role template unavailable");
        return reply.code(503).send({ error: "template_unavailable" });
      }
      const stackName = `AutoInfra-${id.replace(/-/g, "").slice(0, 8)}`;
      const params = ["ConnectionId", "RoleName", "ExternalId"]
        .map((k) => `ParameterKey=${k},UsePreviousValue=true`)
        .join(" ");
      return {
        stackName,
        region: template.region,
        templateUrl: template.templateUrl,
        consoleUrl: `https://${template.region}.console.aws.amazon.com/cloudformation/home?region=${template.region}#/stacks?filteringText=${stackName}`,
        command: `aws cloudformation update-stack --region ${template.region} --stack-name ${stackName} --template-url "${template.templateUrl}" --parameters ${params} --capabilities CAPABILITY_NAMED_IAM`,
      };
    },
  );

  app.get("/aws/connections/:id/template", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = await prisma.awsConnection.findFirst({
      where: { id, userId: request.user!.id },
    });
    if (!connection) return reply.code(404).send({ error: "not_found" });

    let platformAccountId: string;
    try {
      platformAccountId = await getPlatformAccountId(connection.region);
    } catch (err) {
      request.log.error({ err }, "failed to resolve platform AWS account id");
      return reply.code(503).send({
        error: "platform_aws_credentials_unavailable",
        message: "The AutoInfra server has no AWS credentials configured -- see README.",
      });
    }

    const template = buildDeployRoleTemplate(platformAccountId, {
      externalId: connection.externalId,
      connectionId: connection.id,
      registrationTopicArn: await deps.registrationTopicArn().catch(() => undefined),
    });
    reply.header("content-type", "text/yaml");
    reply.header("content-disposition", 'attachment; filename="autoinfra-deploy-role.yaml"');
    return template;
  });

  app.patch(
    "/aws/connections/:id/role",
    { preHandler: [requireAuth, limits.awsConnect] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = SetAwsConnectionRoleInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input", details: parsed.error.issues });
      }
      const existing = await prisma.awsConnection.findFirst({
        where: { id, userId: request.user!.id },
      });
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const connection = await prisma.awsConnection.update({
        where: { id },
        data: {
          roleArn: parsed.data.roleArn,
          region: parsed.data.region ?? existing.region,
          // Changing the role invalidates any prior verification.
          verifiedAt: null,
          accountRegime: null,
          planStateJson: Prisma.JsonNull,
        },
      });
      return toConnectionSummary(connection);
    },
  );

  app.post(
    "/aws/connections/:id/verify",
    { preHandler: [requireAuth, limits.awsConnect] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const connection = await prisma.awsConnection.findFirst({
        where: { id, userId: request.user!.id },
      });
      if (!connection) return reply.code(404).send({ error: "not_found" });
      if (!connection.roleArn) {
        return reply
          .code(400)
          .send({ error: "role_not_set", message: "Paste the role ARN before verifying." });
      }

      try {
        const result = await verifyConnection(prisma, aws, connection);
        await prisma.auditEvent.create({
          data: {
            userId: request.user!.id,
            action: "aws_connection_verified",
            targetType: "aws_connection",
            targetId: id,
            metadata: { roleArn: connection.roleArn, regime: result.connection.accountRegime },
          },
        });
        return {
          ...toConnectionSummary(result.connection),
          needsManualRegime: result.needsManualRegime,
          eligibleInstanceTypes: result.eligibleInstanceTypes,
        };
      } catch (err) {
        if (!(err instanceof VerifyError)) throw err;
        return reply.code(400).send({ error: "assume_role_failed", message: err.message });
      }
    },
  );

  app.post("/aws/connections/:id/regime", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SetAwsConnectionRegimeInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", details: parsed.error.issues });
    }
    const existing = await prisma.awsConnection.findFirst({
      where: { id, userId: request.user!.id },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (!existing.verifiedAt) {
      return reply.code(400).send({
        error: "not_verified",
        message: "Verify the role before setting the account regime manually.",
      });
    }

    const priorState = (existing.planStateJson as Record<string, unknown> | null) ?? {};
    const connection = await prisma.awsConnection.update({
      where: { id },
      data: {
        accountRegime: parsed.data.regime,
        planStateJson: { ...priorState, source: "user" },
      },
    });
    await prisma.auditEvent.create({
      data: {
        userId: request.user!.id,
        action: "aws_regime_set",
        targetType: "aws_connection",
        targetId: id,
        metadata: { regime: parsed.data.regime },
      },
    });
    return toConnectionSummary(connection);
  });

  app.delete("/aws/connections/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.awsConnection.findFirst({
      where: { id, userId: request.user!.id },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const activeDeployments = await prisma.deployment.count({
      where: { awsConnectionId: id, status: { notIn: ["destroyed"] } },
    });
    if (activeDeployments > 0) {
      return reply.code(409).send({
        error: "active_deployments_exist",
        message: "Destroy all deployments using this AWS connection before disconnecting it.",
      });
    }

    await prisma.awsConnection.delete({ where: { id } });
    await prisma.auditEvent.create({
      data: {
        userId: request.user!.id,
        action: "aws_connection_removed",
        targetType: "aws_connection",
        targetId: id,
        metadata: { roleArn: existing.roleArn },
      },
    });
    return reply.code(204).send();
  });
}
