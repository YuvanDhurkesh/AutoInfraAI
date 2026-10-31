import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { instanceLogs } from "./app-logs.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "x" };
afterEach(() => vi.restoreAllMocks());

describe("instanceLogs", () => {
  it("reads one container's last lines over SSM, read-only and with URL passwords masked", async () => {
    const commands: string[] = [];
    let polls = 0;
    vi.spyOn(SSMClient.prototype, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof SendCommandCommand) {
        commands.push(...(command.input.Parameters?.commands ?? []));
        return { Command: { CommandId: "c-1" } };
      }
      if (command instanceof GetCommandInvocationCommand) {
        polls++;
        if (polls === 1)
          throw Object.assign(new Error("not yet"), { name: "InvocationDoesNotExist" });
        if (polls === 2) return { Status: "InProgress" };
        return {
          Status: "Success",
          StandardOutputContent: "app-1 | Server is running\n\napp-1 | ok\n",
        };
      }
      throw new Error("unexpected command");
    });
    const lines = await instanceLogs({
      credentials: creds,
      region: "ap-south-1",
      instanceId: "i-1",
      service: "app",
      lines: 9999,
      pollMs: 0,
    });
    expect(lines).toEqual(["app-1 | Server is running", "app-1 | ok"]);
    expect(commands[0]).toContain("docker compose logs --no-color --timestamps --tail 500 app");
    expect(commands[0]).toContain("***@");
  });

  it("refuses a service name it doesn't know (nothing reaches the shell)", async () => {
    const send = vi.spyOn(SSMClient.prototype, "send");
    await expect(
      instanceLogs({
        credentials: creds,
        region: "ap-south-1",
        instanceId: "i-1",
        service: "app; rm -rf /" as never,
        lines: 10,
        pollMs: 0,
      }),
    ).rejects.toThrow(/unknown service/);
    expect(send).not.toHaveBeenCalled();
  });
});
