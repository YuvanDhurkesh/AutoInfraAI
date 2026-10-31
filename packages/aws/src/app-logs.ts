import { runOnInstance, type InstanceTarget } from "./instance-command.js";

/** The containers an F2 instance runs (docker-compose service names). */
export const INSTANCE_SERVICES = ["app", "web", "db", "cache", "caddy"] as const;
export type InstanceService = (typeof INSTANCE_SERVICES)[number];

/** Passwords in connection URLs (mongodb+srv://user:secret@...) never leave the instance. */
const MASK_URL_PASSWORDS = "sed -E 's#(://[^:/@ ]+:)[^@ ]+@#\\1***@#g'";

/**
 * The last lines one container on the F2 instance logged, read over SSM Run
 * Command. Read-only on the instance: `docker compose logs`, URL passwords
 * masked there.
 */
export async function instanceLogs(
  opts: InstanceTarget & { service: InstanceService; lines: number },
): Promise<string[]> {
  if (!INSTANCE_SERVICES.includes(opts.service)) throw new Error(`unknown service ${opts.service}`);
  const lines = Math.min(Math.max(Math.trunc(opts.lines) || 200, 1), 500);
  const res = await runOnInstance(
    opts,
    [
      `cd /opt/autoinfra && docker compose logs --no-color --timestamps --tail ${lines} ${opts.service} 2>&1 | ${MASK_URL_PASSWORDS}`,
    ],
    "AutoInfra: read app logs (read-only)",
  );
  return `${res.stdout}${res.stderr}`.split("\n").filter((l) => l.trim() !== "");
}
