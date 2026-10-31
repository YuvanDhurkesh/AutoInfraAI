import path from "node:path";
import { readFileSafe } from "../fs-utils.js";

export const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

/**
 * The Dockerfile stage the repository's own compose file builds for the
 * backend (`build: { context: backend, target: development }`). Without it
 * `docker build` takes the last stage -- in Docker's own samples a
 * developer-tools stage (dev-envs), not the app. Only a stage the
 * Dockerfile really has counts.
 */
export function composeBuildTarget(
  composeDirs: string[],
  backendDir: string,
  dockerfile: string,
): string | undefined {
  const wanted = path.resolve(backendDir);
  for (const dir of [...new Set(composeDirs)]) {
    for (const name of COMPOSE_FILES) {
      const lines = (readFileSafe(path.join(dir, name)) ?? "").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const build = lines[i]!.match(/^(\s*)build:\s*(#.*)?$/);
        if (!build) continue;
        const indent = build[1]!.length;
        let context: string | undefined;
        let target: string | undefined;
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j]!;
          if (!line.trim() || line.trim().startsWith("#")) continue;
          if (line.search(/\S/) <= indent) break;
          context = line.match(/^\s*context:\s*["']?([^"'#\s]+)/)?.[1] ?? context;
          target = line.match(/^\s*target:\s*["']?([A-Za-z0-9._-]+)/)?.[1] ?? target;
        }
        const stage = new RegExp(
          `^FROM\\s+\\S+\\s+AS\\s+${target?.replaceAll(".", "\\.")}\\s*$`,
          "im",
        );
        if (target && context && path.resolve(dir, context) === wanted && stage.test(dockerfile))
          return target;
      }
    }
  }
  return undefined;
}

/** Stages for working on the app, not running it: Docker's dev-envs, test runners. */
const DEV_STAGE =
  /^(dev|devel|develop|development|dev-?envs?|devcontainer|test|tests|testing|debug)$/i;
const PRODUCTION_STAGE = /^(prod|production|release|runtime|runner|final|serve|server)$/i;

/**
 * The stage to build for production. Docker builds the last one, and usually
 * that is the production image -- even when the repo's compose file builds a
 * development stage for local work (react-rust-postgres compiles with `cargo
 * run` when that container starts). Only when the last stage is for
 * development (Docker's samples end with dev-envs): a production-named stage,
 * else the one the compose file builds.
 */
export function dockerBuildTarget(
  dockerfile: string,
  composeTarget: string | undefined,
): string | undefined {
  const stages = [...dockerfile.matchAll(/^FROM\s+\S+(?:\s+AS\s+([A-Za-z0-9._-]+))?\s*$/gim)].map(
    (m) => m[1],
  );
  const last = stages.at(-1);
  if (!last || !DEV_STAGE.test(last)) return undefined;
  return [...stages].reverse().find((s) => s && PRODUCTION_STAGE.test(s)) ?? composeTarget;
}
