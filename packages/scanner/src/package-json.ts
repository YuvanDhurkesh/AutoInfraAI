import path from "node:path";
import { readFileSafe } from "./fs-utils.js";

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  /** Create React App's dev-server proxy target. */
  proxy?: unknown;
  /** npm/yarn workspaces: this package.json is a monorepo root, not an app. */
  workspaces?: unknown;
}

export function readPackageJson(dir: string): PackageJson | null {
  const raw = readFileSafe(path.join(dir, "package.json"));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

export function allDeps(pkg: PackageJson): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

export function hasDep(pkg: PackageJson, ...names: string[]): boolean {
  const deps = allDeps(pkg);
  return names.some((n) => n in deps);
}
