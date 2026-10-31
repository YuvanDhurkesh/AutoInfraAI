import type { ArchitecturePlan, RepoProfile } from "@autoinfra/shared";
import { lambdaAdapterLayerArn } from "@autoinfra/terraform-reference";
import type { TfVars } from "@autoinfra/terraform-runner";

const PREFERRED_INSTANCE_TYPES = ["t3.micro", "t2.micro", "t3a.micro", "t4g.micro"];

export function shortIdFor(deploymentId: string): string {
  return deploymentId.replace(/-/g, "").slice(0, 8);
}

function normalizePrefix(prefix: string): string {
  const trimmed = `/${prefix.trim().replace(/^\/+|\/+$/g, "")}`;
  return trimmed === "/" ? "/api" : trimmed;
}

/** Graviton types (t4g, m7g, ...) are arm64. */
export function architectureFor(instanceType: string): "x86_64" | "arm64" {
  return /^[a-z]+\d+[a-z]*g[a-z]*\./.test(instanceType) ? "arm64" : "x86_64";
}

export function pickInstanceType(eligible: string[]): string {
  return PREFERRED_INSTANCE_TYPES.find((t) => eligible.includes(t)) ?? eligible[0] ?? "t3.micro";
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * What to probe through CloudFront. When the app's own routes already live
 * under the API prefix (nothing is stripped), a health route outside it
 * (e.g. /health next to /api/tasks) is unreachable through CloudFront -- probe
 * a real API route instead of a /api/health that 404s (or 500s).
 */
export function healthCheckPathFor(profile: RepoProfile, apiPathPrefix: string): string {
  const health = profile.backend?.healthEndpoint;
  const routes = profile.backend?.apiRoutePrefix;
  if (health && routes && under(routes, apiPathPrefix) && !under(health, apiPathPrefix)) {
    return routes;
  }
  return health ?? "/";
}

/**
 * Every value here is decided by the platform from the deployment, the scan,
 * and the verified AWS connection -- never by the model. In particular the F1
 * Function URL auth type: AWS_IAM + CloudFront OAC when the API is read-only,
 * NONE when it has write routes, because OAC to a Function URL breaks browser
 * POST/PUT (the client would have to send a payload hash).
 */
export function buildTfVars(input: {
  deploymentId: string;
  ownerId: string;
  region: string;
  plan: ArchitecturePlan;
  profile: RepoProfile;
  eligibleInstanceTypes: string[];
}): TfVars {
  const instanceType = pickInstanceType(input.eligibleInstanceTypes);
  const apiPathPrefix = normalizePrefix(input.plan.routing.apiPathPrefix || "/api");
  return {
    region: input.region,
    deployment_id: input.deploymentId,
    owner: input.ownerId,
    short_id: shortIdFor(input.deploymentId),
    api_path_prefix: apiPathPrefix,
    app_port: input.profile.backend?.port ?? 8080,
    health_check_path: healthCheckPathFor(input.profile, apiPathPrefix),
    function_url_auth_type: input.profile.backend?.hasMutatingRoutes === false ? "AWS_IAM" : "NONE",
    lambda_adapter_layer_arn: lambdaAdapterLayerArn(input.region),
    instance_type: instanceType,
    instance_architecture: architectureFor(instanceType),
  };
}
