import type { PlanResourceChange, PlanSummary } from "@autoinfra/shared";
import type { PlanJson } from "./plan-json.js";

const DATA_BEARING = new Set([
  "aws_db_instance",
  "aws_ebs_volume",
  "aws_dynamodb_table",
  "aws_s3_bucket",
  "aws_instance",
  "aws_ecr_repository",
]);

function actionOf(actions: string[]): PlanResourceChange["action"] {
  if (actions.includes("delete") && actions.includes("create")) return "replace";
  return (actions[0] ?? "no-op") as PlanResourceChange["action"];
}

export function summarizePlan(plan: PlanJson): PlanSummary {
  const resources: PlanResourceChange[] = (plan.resource_changes ?? [])
    .filter((rc) => rc.mode === "managed")
    .map((rc) => ({
      address: rc.address,
      type: rc.type,
      action: actionOf(rc.change.actions),
      dataBearing: DATA_BEARING.has(rc.type),
    }));
  const count = (a: PlanResourceChange["action"]) => resources.filter((r) => r.action === a).length;
  return {
    adds: count("create"),
    changes: count("update"),
    destroys: count("delete"),
    replaces: count("replace"),
    resources,
    dataBearingDestroys: resources
      .filter((r) => r.dataBearing && (r.action === "delete" || r.action === "replace"))
      .map((r) => r.address),
  };
}
