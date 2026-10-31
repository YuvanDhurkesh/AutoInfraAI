import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { AwsCredentialIdentity } from "@smithy/types";

export interface InstanceTarget {
  credentials: AwsCredentialIdentity;
  region: string;
  instanceId: string;
  /** Between polls for the command's result (tests pass 0). */
  pollMs?: number;
}

/**
 * Runs one shell script on the F2 instance over SSM Run Command (the role
 * already sends the rollout that way) and waits for it. SSM keeps at most
 * 24,000 characters of stdout and 8,000 of stderr.
 */
export async function runOnInstance(
  target: InstanceTarget,
  commands: string[],
  comment: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const ssm = new SSMClient({ region: target.region, credentials: target.credentials });
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [target.instanceId],
      DocumentName: "AWS-RunShellScript",
      Comment: comment,
      TimeoutSeconds: 60,
      Parameters: { commands },
    }),
  );
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("SSM returned no command id");
  const pollMs = target.pollMs ?? 1500;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const res = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: target.instanceId }),
      );
      if (res.Status === "Pending" || res.Status === "InProgress" || res.Status === "Delayed")
        continue;
      return {
        ok: res.Status === "Success",
        stdout: res.StandardOutputContent ?? "",
        stderr: res.StandardErrorContent ?? "",
      };
    } catch (err) {
      // Right after SendCommand the invocation may not exist yet.
      if ((err as { name?: string }).name === "InvocationDoesNotExist") continue;
      throw err;
    }
  }
  throw new Error("the instance did not answer within 45 seconds");
}
