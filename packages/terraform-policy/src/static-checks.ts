import type { TerraformFile } from "@autoinfra/shared";

/**
 * Runs on the raw generated files BEFORE `terraform init/validate/plan`.
 * Plan-JSON checks come too late for anything Terraform executes during
 * planning on the worker itself: `data "external"` runs a program at plan
 * time, `http` data sources are an SSRF vector from the worker, file()
 * functions can read worker files into resource attributes, and modules or
 * extra providers pull and execute arbitrary code during init.
 */
const BANNED_BLOCKS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bprovisioner\s+"/,
    message: "provisioner blocks (local-exec/remote-exec/file) are not allowed",
  },
  {
    pattern: /\bdata\s+"external"/,
    message: 'data "external" is not allowed (runs programs on the worker)',
  },
  {
    pattern: /\bdata\s+"http"/,
    message: 'data "http" is not allowed (outbound requests from the worker)',
  },
  {
    pattern: /\b(resource|data)\s+"(null_resource|terraform_data)"/,
    message: "null_resource/terraform_data are not allowed",
  },
  {
    pattern: /\b(resource|data)\s+"(local_file|local_sensitive_file|archive_file)"/,
    message: "local/archive providers are not allowed",
  },
  { pattern: /\bmodule\s+"/, message: "module blocks are not allowed; write resources directly" },
  { pattern: /\bbackend\s+"(?!s3")/, message: 'only backend "s3" is allowed' },
  { pattern: /\bcloud\s*\{/, message: "Terraform Cloud blocks are not allowed" },
];

const FILE_FUNCTION =
  /\b(file|filebase64|filebase64sha256|filesha256|filemd5|fileexists|fileset|templatefile)\s*\(\s*([^,)]*)/g;

const ALLOWED_PROVIDER_SOURCES = new Set(["hashicorp/aws", "hashicorp/random"]);

function stripComments(hcl: string): string {
  return hcl.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])(#|\/\/).*$/gm, "$1");
}

export function checkStaticTerraform(files: TerraformFile[]): string[] {
  const errors: string[] = [];
  for (const file of files.filter((f) => f.path.endsWith(".tf"))) {
    const hcl = stripComments(file.content);

    for (const { pattern, message } of BANNED_BLOCKS) {
      if (pattern.test(hcl)) errors.push(`${file.path}: ${message}`);
    }

    for (const match of hcl.matchAll(FILE_FUNCTION)) {
      const arg = (match[2] ?? "").trim();
      const safe = arg.startsWith('"${path.module}/') && !arg.includes("..");
      if (!safe) {
        errors.push(
          `${file.path}: ${match[1]}() may only read files under "\${path.module}/" (got ${arg || "an expression"})`,
        );
      }
    }

    for (const match of hcl.matchAll(/source\s*=\s*"([^"]+)"/g)) {
      const source = match[1]!;
      // Only flag provider-style sources (namespace/type); bucket/route
      // attributes named "source" don't look like this.
      if (/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(source) && !ALLOWED_PROVIDER_SOURCES.has(source)) {
        errors.push(
          `${file.path}: provider source "${source}" is not allowed (only hashicorp/aws and hashicorp/random)`,
        );
      }
    }
  }
  return errors;
}
