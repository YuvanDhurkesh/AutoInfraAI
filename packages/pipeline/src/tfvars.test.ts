import { describe, expect, it } from "vitest";
import type { ArchitecturePlan, RepoProfile } from "@autoinfra/shared";
import {
  architectureFor,
  buildTfVars,
  healthCheckPathFor,
  pickInstanceType,
  shortIdFor,
} from "./tfvars.js";

const plan = { routing: { apiPathPrefix: "/api/" } } as ArchitecturePlan;
const backend = {
  language: "node",
  isStatelessHttp: true,
  usesWebSockets: false,
  hasLocalDiskPersistence: false,
  lambdaCompatible: true,
};

function profile(hasMutatingRoutes?: boolean): RepoProfile {
  return { backend: { ...backend, hasMutatingRoutes, port: 4000 } } as unknown as RepoProfile;
}

const base = {
  deploymentId: "8f3c2a10-0000-0000-0000-000000000000",
  ownerId: "u",
  region: "ap-south-1",
  plan,
};

describe("buildTfVars", () => {
  it("uses AWS_IAM + OAC only when the API has no write routes", () => {
    expect(
      buildTfVars({ ...base, profile: profile(false), eligibleInstanceTypes: [] })
        .function_url_auth_type,
    ).toBe("AWS_IAM");
    expect(
      buildTfVars({ ...base, profile: profile(true), eligibleInstanceTypes: [] })
        .function_url_auth_type,
    ).toBe("NONE");
    // Unknown counts as "has writes": a broken app is the worse failure.
    expect(
      buildTfVars({ ...base, profile: profile(undefined), eligibleInstanceTypes: [] })
        .function_url_auth_type,
    ).toBe("NONE");
  });

  it("normalizes the API prefix and derives a short id", () => {
    const vars = buildTfVars({ ...base, profile: profile(true), eligibleInstanceTypes: [] });
    expect(vars.api_path_prefix).toBe("/api");
    expect(vars.short_id).toBe("8f3c2a10");
    expect(shortIdFor("ab-cd")).toBe("abcd");
  });

  it("probes a reachable API route when the health route sits outside the API prefix", () => {
    const withRoutes = (healthEndpoint: string, apiRoutePrefix?: string) =>
      ({ backend: { ...backend, healthEndpoint, apiRoutePrefix } }) as unknown as RepoProfile;
    // Real repo: /health next to /api/tasks -- /api/health 404s through CloudFront.
    expect(healthCheckPathFor(withRoutes("/health", "/api/tasks"), "/api")).toBe("/api/tasks");
    expect(healthCheckPathFor(withRoutes("/api/health", "/api"), "/api")).toBe("/api/health");
    // Routes not under the prefix: the prefix is stripped, /health maps through.
    expect(healthCheckPathFor(withRoutes("/health", undefined), "/api")).toBe("/health");
  });

  it("prefers x86 Free-Tier types and derives the architecture", () => {
    expect(pickInstanceType(["t4g.micro", "t3.micro"])).toBe("t3.micro");
    expect(pickInstanceType(["t4g.micro"])).toBe("t4g.micro");
    expect(architectureFor("t4g.micro")).toBe("arm64");
    expect(architectureFor("t3.micro")).toBe("x86_64");
    expect(architectureFor("t3a.micro")).toBe("x86_64");
  });
});
