import {
  TerraformBundle,
  type ArchitecturePlan,
  type RepoProfile,
  type TerraformFile,
} from "@autoinfra/shared";
import type { LlmClient } from "./client.js";
import { redactProfileForLlm } from "./redact.js";
import {
  buildTerraformSystemPrompt,
  buildTerraformUserPrompt,
} from "./prompts/terraform-prompt.js";

export interface GenerateTerraformInput {
  plan: ArchitecturePlan;
  profile: RepoProfile;
  platformFiles: TerraformFile[];
  reference: TerraformFile[];
  functionUrlAuth?: "AWS_IAM" | "NONE";
  /** Present on self-repair attempts. */
  repair?: { files: TerraformFile[]; errors: string[] };
  /** A change request against the live project (kept through repairs). */
  change?: { files: TerraformFile[]; request: string };
}

export class TerraformGenerationError extends Error {}

const SCHEMA_ATTEMPTS = 2;

/**
 * One generation (or repair) call. Only schema-level failures are retried
 * here; validation-gauntlet failures are fed back by the caller, which owns
 * the attempt budget (Sec. 5 Step 4: max 4 attempts).
 */
export async function generateTerraform(
  client: LlmClient,
  input: GenerateTerraformInput,
): Promise<TerraformBundle> {
  const platformPaths = new Set(input.platformFiles.map((f) => f.path));
  const system = buildTerraformSystemPrompt(input);
  let schemaErrors: string[] | undefined;

  for (let i = 0; i < SCHEMA_ATTEMPTS; i++) {
    const repair = schemaErrors
      ? {
          files: input.repair?.files ?? [],
          errors: [...(input.repair?.errors ?? []), ...schemaErrors],
        }
      : input.repair;
    const raw = await client.generateJson({
      purpose: input.repair ? "terraform_repair" : "terraform",
      system,
      user: buildTerraformUserPrompt(
        input.plan,
        redactProfileForLlm(input.profile),
        repair,
        input.change,
      ),
      schema: TerraformBundle,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      schemaErrors = ["Response was not valid JSON."];
      continue;
    }
    // Platform-managed files are always ours; a model copy is dropped rather
    // than failing the whole attempt.
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { files?: unknown }).files)
    ) {
      (parsed as { files: Array<{ path?: unknown }> }).files = (
        parsed as { files: Array<{ path?: unknown }> }
      ).files.filter((f) => typeof f.path !== "string" || !platformPaths.has(f.path));
    }
    const result = TerraformBundle.safeParse(parsed);
    if (result.success) return result.data;
    schemaErrors = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  }

  throw new TerraformGenerationError(
    `Gemini returned an invalid Terraform bundle: ${(schemaErrors ?? []).slice(0, 5).join("; ")}`,
  );
}
