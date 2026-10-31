import { describe, expect, it } from "vitest";
import { DeploymentPattern, DeploymentStatus } from "./enums.js";
import { SignupInput } from "./auth.js";

describe("shared schemas", () => {
  it("accepts a valid deployment pattern", () => {
    expect(DeploymentPattern.parse("F1")).toBe("F1");
  });

  it("rejects an invalid deployment pattern", () => {
    expect(() => DeploymentPattern.parse("F4")).toThrow();
  });

  it("accepts every documented deployment status", () => {
    for (const status of DeploymentStatus.options) {
      expect(DeploymentStatus.parse(status)).toBe(status);
    }
  });

  it("rejects a signup password shorter than 12 characters", () => {
    const result = SignupInput.safeParse({ email: "a@example.com", password: "short" });
    expect(result.success).toBe(false);
  });
});
