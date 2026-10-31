import { describe, expect, it } from "vitest";
import { jsonLogReader } from "./json-log.js";

describe("jsonLogReader", () => {
  it("keeps the diagnostic's detail -- the AWS reason -- for the log and the failure message", () => {
    const logged: string[] = [];
    const reader = jsonLogReader((line) => logged.push(line));
    reader.onLine(
      JSON.stringify({
        "@level": "info",
        "@message": "aws_cloudwatch_metric_alarm.cpu_high: Creating...",
        type: "apply_start",
      }),
    );
    reader.onLine(
      JSON.stringify({
        "@level": "error",
        "@message": "Error: creating CloudWatch Metric Alarm",
        type: "diagnostic",
        diagnostic: {
          severity: "error",
          summary: "creating CloudWatch Metric Alarm",
          detail:
            "ID: autoinfra-x-cpu-high\nCause: api error AccessDenied: User is not authorized to perform: cloudwatch:PutMetricAlarm",
        },
      }),
    );
    reader.onLine("not json");
    expect(logged).toEqual([
      "aws_cloudwatch_metric_alarm.cpu_high: Creating...",
      "Error: creating CloudWatch Metric Alarm",
      "  ID: autoinfra-x-cpu-high",
      "  Cause: api error AccessDenied: User is not authorized to perform: cloudwatch:PutMetricAlarm",
      "not json",
    ]);
    // Terraform's stderr is empty in -json mode: the message comes from the diagnostics.
    expect(reader.errorText("")).toBe(
      "creating CloudWatch Metric Alarm: ID: autoinfra-x-cpu-high Cause: api error AccessDenied: User is not authorized to perform: cloudwatch:PutMetricAlarm",
    );
  });

  it("falls back to stderr, and logs only the types it is given", () => {
    const logged: string[] = [];
    const reader = jsonLogReader((line) => logged.push(line), new Set(["apply_complete"]));
    reader.onLine(JSON.stringify({ "@message": "x: Destroying...", type: "apply_start" }));
    expect(logged).toEqual([]);
    expect(reader.errorText(" plugin crashed \n")).toBe("plugin crashed");
  });
});
