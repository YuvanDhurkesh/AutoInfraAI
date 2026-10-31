import { isDatabaseSetting } from "@autoinfra/shared";
import { readEnvExamples } from "./detect-env-vars.js";

/**
 * Hosted database services, by the domain their connection strings use.
 * A repo whose env template points the database here keeps its data there.
 */
const HOSTED_DATABASE_DOMAINS = [
  "neon.tech",
  "supabase.co",
  "supabase.com",
  "mongodb.net",
  "psdb.cloud",
  "planetscale.com",
  "upstash.io",
  "redislabs.com",
  "redis-cloud.com",
  "render.com",
  "railway.app",
  "rlwy.net",
  "aivencloud.com",
  "cockroachlabs.cloud",
  "timescale.com",
  "tidbcloud.com",
  "xata.sh",
  "elephantsql.com",
  "ondigitalocean.com",
  "database.azure.com",
  "cosmos.azure.com",
  "rds.amazonaws.com",
  "prisma-data.net",
];

/** "postgres://u:p@ep-x.us-east-2.aws.neon.tech/db" -> "neon.tech". */
export function hostedDomain(value: string): string | undefined {
  const host = value.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/?\s,]+)/i)?.[1] ?? value;
  const lower = host.toLowerCase();
  return HOSTED_DATABASE_DOMAINS.find((d) => lower === d || lower.endsWith(`.${d}`));
}

/** The hosted provider the app folders' env templates point the database at, if any. */
export function detectHostedDatabase(dirs: string[], database: string): string | undefined {
  if (database === "none") return undefined;
  for (const dir of dirs) {
    for (const { name, value } of readEnvExamples(dir)) {
      if (!isDatabaseSetting(name, database)) continue;
      const domain = hostedDomain(value);
      if (domain) return domain;
    }
  }
  return undefined;
}
