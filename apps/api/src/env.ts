import { z } from "zod";

// .env commonly leaves not-yet-configured optional vars as an empty string
// (e.g. `GITHUB_CLIENT_ID=`) rather than omitting them -- treat that the same
// as unset instead of failing validation.
const optionalString = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  COOKIE_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  GEMINI_API_KEY: optionalString(),
  GEMINI_MODEL: optionalString(),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  GITHUB_CLIENT_ID: optionalString(),
  GITHUB_CLIENT_SECRET: optionalString(),
  /** Analyze/design/generate/apply steps one owner may have running at once. */
  MAX_RUNNING_JOBS_PER_USER: z.coerce.number().int().positive().default(3),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return parsed.data;
}
