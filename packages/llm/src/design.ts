import { ArchitecturePlan, type RepoProfile } from "@autoinfra/shared";
import { architectureToResources, evaluateFreeTier } from "@autoinfra/free-tier-policy";
import type { LlmClient } from "./client.js";
import { redactProfileForLlm } from "./redact.js";
import {
  buildDesignSystemPrompt,
  buildDesignUserPrompt,
  type DesignOptions,
} from "./prompts/design-prompt.js";

export class DesignFailedError extends Error {
  constructor(
    message: string,
    readonly attempts: string[][],
  ) {
    super(message);
  }
}

const MAX_ATTEMPTS = 3;

/** Datastores that need a server process; F1 (Lambda) has nowhere to run them. */
const SERVER_DATABASES = new Set(["postgres", "mysql", "redis", "mongo", "sqlite"]);

function validate(
  raw: string,
  profile: RepoProfile,
  options: DesignOptions,
  existingAlwaysOnEc2Count: number,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: ["Response was not valid JSON."] };
  }
  const result = ArchitecturePlan.safeParse(parsed);
  if (!result.success) {
    return {
      errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  // The app would deploy but crash on its first database call.
  if (
    result.data.pattern === "F1" &&
    SERVER_DATABASES.has(profile.database) &&
    !profile.databaseExternal
  ) {
    return {
      errors: [
        `The app uses ${profile.database}, which needs a server: F1 (Lambda) has nowhere to run it. Use F2 with ${profile.database} as a container on the instance${options.allowRds && profile.database !== "redis" ? " or a single-AZ RDS micro instance" : ""}.`,
      ],
    };
  }

  // Strict mode: the server -- not the model -- decides whether the design
  // fits. Violations go back to the model to fix (Sec. 2, "sent back to
  // Gemini to fix, never silently applied"). Flexible mode lets them
  // through to the review screen, where the user must confirm the cost.
  if (options.freeTierMode === "strict") {
    const report = evaluateFreeTier({
      plan: { resources: architectureToResources(result.data) },
      freeTierMode: "strict",
      eligibleInstanceTypes: options.eligibleInstanceTypes.length
        ? options.eligibleInstanceTypes
        : undefined,
      existingAlwaysOnEc2Count,
    });
    if (report.denyListViolations.length > 0) {
      return { errors: report.denyListViolations.map((v) => `Free Tier policy: ${v}`) };
    }
  }
  // S3 can only serve files: a Next.js app with SSR/middleware needs its server.
  if (profile.frontend?.isSSR && result.data.pattern !== "F2") {
    return {
      errors: [
        `The frontend is ${profile.frontend.framework} with server-side rendering, which needs a running Node server: use F2 and run it as a container on the instance (S3 can only serve static files).`,
      ],
    };
  }

  // A database hosted outside AWS must not get a second copy inside it.
  if (profile.databaseExternal) {
    const dbResources = result.data.components.filter((c) =>
      /^aws_(db_instance|rds_|dynamodb_table)/.test(c.service),
    );
    if (dbResources.length) {
      return {
        errors: [
          `The app's ${profile.database} database is hosted outside AWS (databaseExternal): remove ${dbResources.map((c) => c.service).join(", ")} -- the app connects to the external database with the connection settings in its env vars.`,
        ],
      };
    }
  }
  return { plan: result.data };
}

export async function designArchitecture(
  client: LlmClient,
  profile: RepoProfile,
  options: DesignOptions & { existingAlwaysOnEc2Count?: number },
): Promise<ArchitecturePlan> {
  if (profile.unsupportedReasons.length > 0) {
    throw new DesignFailedError(
      `Repository is not supported: ${profile.unsupportedReasons.join(" ")}`,
      [],
    );
  }

  const system = buildDesignSystemPrompt(options);
  const redacted = redactProfileForLlm(profile);
  const attempts: string[][] = [];

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const raw = await client.generateJson({
      purpose: "design",
      system,
      user: buildDesignUserPrompt(redacted, attempts.at(-1)),
      schema: ArchitecturePlan,
    });
    const { plan, errors } = validate(raw, profile, options, options.existingAlwaysOnEc2Count ?? 0);
    if (plan) return plan;
    attempts.push(errors);
  }

  throw new DesignFailedError(
    `Gemini could not produce a valid Free-Tier-compliant design after ${MAX_ATTEMPTS} attempts.`,
    attempts,
  );
}
