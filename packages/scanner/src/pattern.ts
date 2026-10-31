import type { DetectedBackend } from "./detectors/detect-backend.js";
import type { DetectedFrontend } from "./detectors/detect-frontend.js";
import type { DatabaseKind } from "./detectors/detect-database.js";

/** Datastores that need a server process -- F1 (Lambda) has nowhere to run them. */
export const SERVER_DATABASES: ReadonlySet<DatabaseKind> = new Set([
  "postgres",
  "mysql",
  "redis",
  "mongo",
  "sqlite",
]);

/**
 * Databases an app can use from a hosted service outside AWS (Atlas, Neon,
 * Supabase, Upstash...) instead of a container on the instance.
 */
export const EXTERNALIZABLE_DATABASES: ReadonlySet<DatabaseKind> = new Set([
  "postgres",
  "mysql",
  "redis",
  "mongo",
]);

export function isDatabaseExternal(database: DatabaseKind, externalRequested: boolean): boolean {
  return externalRequested && EXTERNALIZABLE_DATABASES.has(database);
}

export function computeRecommendedPattern(
  frontend: DetectedFrontend | null,
  backend: DetectedBackend | null,
  database: DatabaseKind = "none",
): "F1" | "F2" | "F3" | undefined {
  // Sec. 11: a server-rendered frontend (Next.js with middleware or dynamic
  // routes, Nuxt, SvelteKit) needs a persistent Node process -- F2 runs it
  // as a container, with or without a separate backend; only a static
  // export is a pure static site (F3).
  if (frontend?.isSSR) return "F2";
  if (backend) return backend.lambdaCompatible && !SERVER_DATABASES.has(database) ? "F1" : "F2";
  if (frontend) return "F3";
  return undefined;
}

const ML_DEPENDENCY_MARKERS = ["torch", "tensorflow", "cuda"];

export function computeUnsupportedReasons(
  frontend: DetectedFrontend | null,
  backend: DetectedBackend | null,
  database: DatabaseKind,
  rawDependencyNames: string[],
): string[] {
  const reasons: string[] = [];

  if (!frontend && !backend) {
    reasons.push("Could not detect a recognizable frontend or backend in this repository.");
  }

  if (
    ML_DEPENDENCY_MARKERS.some((marker) =>
      rawDependencyNames.some((d) => d.toLowerCase().includes(marker)),
    )
  ) {
    reasons.push(
      "Possible GPU/ML workload detected (torch/tensorflow/cuda) -- not supported by any Free-Tier pattern.",
    );
  }

  return reasons;
}
