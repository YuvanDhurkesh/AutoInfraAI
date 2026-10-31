import { PrismaClient, type DeploymentPattern, type DeploymentStatus } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { alwaysOnEc2Holders, otherAlwaysOnEc2 } from "./common.js";

const prisma = new PrismaClient();

describe("the AWS account's one free EC2 instance", () => {
  const userIds: string[] = [];

  afterAll(async () => {
    const where = { ownerId: { in: userIds } };
    await prisma.revision.deleteMany({ where: { deployment: where } });
    await prisma.deployment.deleteMany({ where });
    await prisma.awsConnection.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  const user = async () => {
    const u = await prisma.user.create({
      data: { email: `ec2-${Date.now()}-${Math.random()}@example.com` },
    });
    userIds.push(u.id);
    return u.id;
  };
  const connect = (userId: string, account: string, region = "ap-south-1") =>
    prisma.awsConnection.create({
      data: {
        userId,
        region,
        externalId: "x",
        roleArn: `arn:aws:iam::${account}:role/AutoInfraDeployRole`,
        verifiedAt: new Date(),
      },
    });
  const deploy = (
    conn: { id: string; userId: string; region: string },
    repo: string,
    pattern: DeploymentPattern,
    status: DeploymentStatus,
    instanceId?: string,
  ) =>
    prisma.deployment.create({
      data: {
        ownerId: conn.userId,
        awsConnectionId: conn.id,
        repoUrl: `https://github.com/example/${repo}`,
        branch: "main",
        region: conn.region,
        pattern,
        status,
        revisions: {
          create: {
            number: 1,
            commitSha: "0".repeat(40),
            status,
            action: "initial",
            ...(instanceId ? { outputs: { instance_id: instanceId } } : {}),
          },
        },
      },
    });

  it("counts every connection to the account; a failed one only while it has an instance; not one being destroyed", async () => {
    const account = `9${String(Date.now()).slice(-11)}`;
    const me = await user();
    const mumbai = await connect(me, account);
    const virginia = await connect(me, account, "us-east-1");
    const colleague = await connect(await user(), account);
    const elsewhere = await connect(me, "111111111111");

    const self = await deploy(mumbai, "self", "F2", "awaiting_approval");
    await deploy(virginia, "other-region", "F2", "live", "i-0aaa");
    await deploy(mumbai, "build-failed", "F2", "failed", "i-0bbb");
    await deploy(mumbai, "clone-failed", "F2", "failed");
    await deploy(mumbai, "on-its-way-out", "F2", "destroying", "i-0ccc");
    await deploy(mumbai, "gone", "F2", "destroyed", "i-0ddd");
    await deploy(mumbai, "lambda", "F1", "live");
    await deploy(colleague, "teammate", "F2", "live", "i-0eee");
    await deploy(elsewhere, "other-account", "F2", "live", "i-0fff");

    const holders = await alwaysOnEc2Holders({ prisma }, mumbai.id, self.id);
    expect(
      holders.map((h) => [h.repoUrl.replace("https://github.com/example/", ""), h.status]),
    ).toEqual([
      ["other-region", "live"],
      ["build-failed", "failed"],
      ["teammate", "live"],
    ]);
    expect(holders.filter((h) => h.ownerId !== me)).toHaveLength(1);
    expect(await otherAlwaysOnEc2({ prisma }, mumbai.id, self.id)).toBe(3);
  });
});
