/** The subset of `terraform show -json <planfile>` this package reads. */
export interface PlanJson {
  format_version?: string;
  variables?: Record<string, { value: unknown }>;
  resource_changes?: ResourceChange[];
  configuration?: {
    provider_config?: Record<
      string,
      {
        name: string;
        full_name?: string;
        alias?: string;
        expressions?: Record<string, { constant_value?: unknown; references?: string[] }>;
      }
    >;
  };
}

export interface ResourceChange {
  address: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  provider_name: string;
  change: {
    actions: Array<"no-op" | "create" | "read" | "update" | "delete">;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    after_unknown?: Record<string, unknown>;
  };
}

export const REQUIRED_TAG_KEYS = [
  "autoinfra:deployment-id",
  "autoinfra:owner",
  "autoinfra:managed-by",
  "autoinfra:free-tier",
] as const;

export const ALLOWED_PROVIDERS = [
  "registry.terraform.io/hashicorp/aws",
  "registry.terraform.io/hashicorp/random",
];
