import type {
  ArchitecturePlan,
  FreeTierReport,
  GateResult,
  PlanSummary,
  RepoProfile,
  TerraformBundle,
  TerraformFile,
} from "@autoinfra/shared";
import { generateTerraform, type LlmClient } from "@autoinfra/llm";
import { loadPlatformFiles, loadReference } from "@autoinfra/terraform-reference";
import { repairErrors, runGauntlet, unfinishedReason, type GauntletContext } from "./gauntlet.js";

export const MAX_GENERATION_ATTEMPTS = 4;

export interface AttemptRecord {
  number: number;
  gates: GateResult[];
}

export interface GenerateAndValidateInput extends Omit<
  GauntletContext,
  "bundle" | "pattern" | "onGate"
> {
  plan: ArchitecturePlan;
  profile: RepoProfile;
  onAttempt?: (attempt: AttemptRecord) => void | Promise<void>;
  onGate?: (attemptNumber: number, gate: GateResult) => void | Promise<void>;
  /**
   * Fresh deploy-role credentials for each repair attempt: a session can keep
   * the role's old permissions for a while after the user updates them.
   */
  refreshCredentials?: () => Promise<GauntletContext["credentials"]>;
  /** Edit the live project instead of generating from scratch. */
  change?: { files: TerraformFile[]; request: string };
  /**
   * Re-validate an existing bundle (a rollback to an earlier revision): one
   * gauntlet run against the current state, no model call, no repair.
   */
  reuse?: TerraformBundle;
  /**
   * AutoInfra's own blueprint output: validated as attempt 1. Gemini is only
   * asked to repair it if a gate fails (and a model is configured).
   */
  initial?: TerraformBundle;
}

export interface GenerateAndValidateResult {
  passed: boolean;
  /** Last bundle produced -- kept as an artifact even when validation failed. */
  bundle: TerraformBundle | null;
  attempts: AttemptRecord[];
  planSummary?: PlanSummary;
  freeTierReport?: FreeTierReport;
  failureReason?: string;
}

/**
 * Sec. 5 Step 4: generate -> gauntlet -> feed the exact errors back -> repeat,
 * up to 4 attempts. On exhaustion the last bundle and every attempt's gate
 * results are returned so they can be stored with the revision.
 */
export async function generateAndValidate(
  llm: LlmClient | null,
  input: GenerateAndValidateInput,
): Promise<GenerateAndValidateResult> {
  if (input.reuse) return revalidate(input, input.reuse);
  if (!llm && !input.initial) throw new Error("Terraform generation needs a configured model.");
  const platformFiles = loadPlatformFiles();
  const reference = loadReference(input.plan.pattern);
  const functionUrlAuth =
    input.plan.pattern === "F1" ? input.tfvars.function_url_auth_type : undefined;
  const attempts: AttemptRecord[] = [];
  let bundle: TerraformBundle | null = null;
  let credentials = input.credentials;

  const maxAttempts = llm ? MAX_GENERATION_ATTEMPTS : 1;
  for (let number = 1; number <= maxAttempts; number++) {
    const previous = attempts.at(-1);
    if (number > 1 && input.refreshCredentials) {
      credentials = (await input.refreshCredentials().catch(() => null)) ?? credentials;
    }
    if (number === 1 && input.initial) {
      bundle = input.initial;
    } else {
      try {
        bundle = await generateTerraform(llm!, {
          plan: input.plan,
          profile: input.profile,
          platformFiles,
          reference,
          functionUrlAuth,
          change: input.change,
          repair:
            previous && bundle
              ? { files: bundle.files, errors: repairErrors(previous.gates) }
              : undefined,
        });
      } catch (err) {
        // A blueprint that failed a gate keeps its own errors in front: "Gemini's
        // quota is used up" alone would hide what actually needs fixing.
        if (!previous || !input.initial) throw err;
        return {
          passed: false,
          bundle,
          attempts,
          failureReason: `AutoInfra's blueprint failed validation (${repairErrors(previous.gates).slice(0, 3).join(" | ")}), and Gemini could not be asked to repair it: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const result = await runGauntlet({
      ...input,
      credentials,
      bundle,
      pattern: input.plan.pattern,
      onGate: (gate) => input.onGate?.(number, gate),
    });
    const attempt = { number, gates: result.gates };
    attempts.push(attempt);
    await input.onAttempt?.(attempt);

    if (result.passed) {
      return {
        passed: true,
        bundle,
        attempts,
        planSummary: result.planSummary,
        freeTierReport: result.freeTierReport,
      };
    }

    // Skipped gates (no credentials, missing linters) and failures no edit can
    // fix (the network, a crashed tool) aren't something the model can
    // repair -- stop instead of burning attempts.
    if (repairErrors(result.gates).length === 0) {
      return {
        passed: false,
        bundle,
        attempts,
        planSummary: result.planSummary,
        failureReason: unfinishedReason(result.gates),
      };
    }
  }

  const last = attempts.at(-1)!;
  return {
    passed: false,
    bundle,
    attempts,
    failureReason: `Terraform still failed validation after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}. Last errors: ${repairErrors(last.gates).slice(0, 3).join(" | ")}`,
  };
}

async function revalidate(
  input: GenerateAndValidateInput,
  bundle: TerraformBundle,
): Promise<GenerateAndValidateResult> {
  const result = await runGauntlet({
    ...input,
    bundle,
    pattern: input.plan.pattern,
    onGate: (gate) => input.onGate?.(1, gate),
  });
  const attempt = { number: 1, gates: result.gates };
  await input.onAttempt?.(attempt);
  if (result.passed) {
    return {
      passed: true,
      bundle,
      attempts: [attempt],
      planSummary: result.planSummary,
      freeTierReport: result.freeTierReport,
    };
  }
  const errors = repairErrors(result.gates);
  return {
    passed: false,
    bundle,
    attempts: [attempt],
    planSummary: result.planSummary,
    failureReason: errors.length
      ? `The earlier revision no longer passes validation: ${errors.slice(0, 3).join(" | ")}`
      : unfinishedReason(result.gates),
  };
}
