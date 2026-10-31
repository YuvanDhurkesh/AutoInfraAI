import { describe, expect, it } from "vitest";
import { diagnoseFailure, redactLogLine } from "./diagnose.js";
import { MockLlmClient } from "./mock-client.js";

describe("redactLogLine", () => {
  it("removes credentials before a log line leaves AutoInfra", () => {
    const line =
      "fatal: https://x-access-token:ghs_abc123@github.com/a/b AKIAIOSFODNN7EXAMPLE password=hunter2 api_key: sk-live-1";
    const out = redactLogLine(line);
    expect(out).not.toContain("ghs_abc123");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-live-1");
  });
});

describe("diagnoseFailure", () => {
  it("sends the redacted log tail as untrusted data and validates the answer", async () => {
    const client = new MockLlmClient({
      diagnose: [
        "not json",
        {
          summary: "The build couldn't log in to the registry.",
          likelyCause: "AccessDenied on ecr:GetAuthorizationToken.",
          suggestedFix: "Update the AWS connection's permissions.",
          whoFixes: "user_settings",
        },
      ],
    });
    const d = await diagnoseFailure(client, {
      jobKind: "apply",
      failureReason: "The CodeBuild build failed",
      logLines: ["step 1", "AccessDenied password=hunter2"],
      pattern: "F2",
    });
    expect(d.whoFixes).toBe("user_settings");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]!.user).toContain("<job_log>");
    expect(client.requests[0]!.user).not.toContain("hunter2");
    expect(client.requests[1]!.user).toContain("previous answer was invalid");
  });
});
