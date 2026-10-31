import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TerraformFile } from "@autoinfra/shared";

export * from "./deploy-role-template.js";
export * from "./blueprint/index.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function readTree(dir: string, prefix = ""): TerraformFile[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return readTree(path.join(dir, entry.name), rel);
      // LF only: these files run on Linux (CodeBuild/Lambda/EC2).
      const content = fs.readFileSync(path.join(dir, entry.name), "utf8").replaceAll("\r\n", "\n");
      return [{ path: rel, content }];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Written by AutoInfra on every run; generated bundles never override them. */
export const PLATFORM_FILE_PATHS = new Set(["providers.tf", "variables.tf"]);

export function loadPlatformFiles(): TerraformFile[] {
  return readTree(path.join(PACKAGE_ROOT, "platform"));
}

/** Platform-owned helpers added to every build source under .autoinfra/ (e.g. the SSM env loader). */
export function loadPlatformAppFiles(): TerraformFile[] {
  return readTree(path.join(PACKAGE_ROOT, "platform-app"));
}

/** House-style reference project for a pattern -- Gemini few-shot context. */
export function loadReference(pattern: "F1" | "F2" | "F3"): TerraformFile[] {
  return readTree(path.join(PACKAGE_ROOT, "reference", pattern.toLowerCase()));
}

export const LAMBDA_ADAPTER_LAYER_VERSION = 30;
export const LAMBDA_ADAPTER_ACCOUNT = "753240598075";

export function lambdaAdapterLayerArn(
  region: string,
  architecture: "x86_64" | "arm64" = "x86_64",
): string {
  const name = architecture === "arm64" ? "LambdaAdapterLayerArm64" : "LambdaAdapterLayerX86";
  return `arn:aws:lambda:${region}:${LAMBDA_ADAPTER_ACCOUNT}:layer:${name}:${LAMBDA_ADAPTER_LAYER_VERSION}`;
}
