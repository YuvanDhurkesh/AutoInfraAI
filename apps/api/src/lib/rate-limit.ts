import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

/** Counts hits on a key within a fixed window. */
export interface RateLimitStore {
  /** Increments the key; returns the count so far and ms until the window resets. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

export function memoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, windowMs) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
      }
      w.count++;
      if (windows.size > 50_000) {
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
      }
      return { count: w.count, resetMs: w.resetAt - t };
    },
  };
}

/** Shared across API processes; keys expire with their window. */
export function redisRateLimitStore(redis: Redis): RateLimitStore {
  return {
    async hit(key, windowMs) {
      const k = `autoinfra:rl:${key}`;
      const [[, count], [, ttl]] = (await redis.multi().incr(k).pttl(k).exec()) as [
        [null, number],
        [null, number],
      ];
      if (ttl < 0) {
        await redis.pexpire(k, windowMs);
        return { count, resetMs: windowMs };
      }
      return { count, resetMs: ttl };
    },
  };
}

export interface RateLimitRule {
  /** Groups routes that share one budget, e.g. "llm". */
  name: string;
  limit: number;
  windowMs: number;
  /** Who the budget belongs to. "user" falls back to the IP when signed out. */
  by: "ip" | "user" | ((request: FastifyRequest) => string);
  message?: string;
}

/** A preHandler that answers 429 (with Retry-After) once a rule's budget is spent. */
export function rateLimit(store: RateLimitStore, ...rules: RateLimitRule[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    for (const rule of rules) {
      const who =
        typeof rule.by === "function"
          ? rule.by(request)
          : rule.by === "user" && request.user
            ? `u:${request.user.id}`
            : `ip:${request.ip}`;
      const { count, resetMs } = await store.hit(`${rule.name}:${who}`, rule.windowMs);
      if (count > rule.limit) {
        const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
        return reply
          .code(429)
          .header("retry-after", String(retryAfter))
          .send({
            error: "rate_limited",
            message: `${rule.message ?? "Too many requests."} Try again in ${formatWait(retryAfter)}.`,
            retryAfterSeconds: retryAfter,
          });
      }
    }
  };
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Every limit in one place. Model-backed steps share one budget per user. */
export function buildLimits(store: RateLimitStore) {
  const emailOf = (request: FastifyRequest) => {
    const email = (request.body as { email?: unknown } | undefined)?.email;
    return `e:${typeof email === "string" ? email.trim().toLowerCase() : "-"}`;
  };
  return {
    /** Everything, per IP: a ceiling well above what the UI's polling needs. */
    global: rateLimit(store, { name: "global", limit: 600, windowMs: MINUTE, by: "ip" }),
    login: rateLimit(
      store,
      {
        name: "login-email",
        limit: 10,
        windowMs: 15 * MINUTE,
        by: emailOf,
        message: "Too many sign-in attempts for this account.",
      },
      {
        name: "login-ip",
        limit: 30,
        windowMs: 15 * MINUTE,
        by: "ip",
        message: "Too many sign-in attempts.",
      },
    ),
    signup: rateLimit(store, {
      name: "signup",
      limit: 10,
      windowMs: HOUR,
      by: "ip",
      message: "Too many accounts created from this address.",
    }),
    /** Analyze, design, generate, change requests, diagnosis: each spends Gemini quota. */
    llm: rateLimit(store, {
      name: "llm",
      limit: 30,
      windowMs: HOUR,
      by: "user",
      message: "You've used AutoInfra's AI steps a lot in the last hour.",
    }),
    /** Guessing the current password from a stolen session. */
    passwordChange: rateLimit(store, {
      name: "password-change",
      limit: 10,
      windowMs: HOUR,
      by: "user",
      message: "Too many password attempts.",
    }),
    createDeployment: rateLimit(store, {
      name: "create-deployment",
      limit: 20,
      windowMs: 24 * HOUR,
      by: "user",
      message: "You've created a lot of deployments today.",
    }),
    awsConnect: rateLimit(store, {
      name: "aws-connect",
      limit: 20,
      windowMs: HOUR,
      by: "user",
      message: "Too many AWS connection attempts.",
    }),
    /** Each read runs a command on the owner's instance (or a CloudWatch query). */
    appLogs: rateLimit(store, {
      name: "app-logs",
      limit: 30,
      windowMs: MINUTE,
      by: "user",
      message: "Logs were refreshed a lot in the last minute -- wait a moment.",
    }),
    /** Each read runs a query in the database container on the owner's instance. */
    dbView: rateLimit(store, {
      name: "db-view",
      limit: 30,
      windowMs: MINUTE,
      by: "user",
      message: "The database was read a lot in the last minute -- wait a moment.",
    }),
  };
}
export type Limits = ReturnType<typeof buildLimits>;
