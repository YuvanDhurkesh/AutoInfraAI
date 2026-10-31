/**
 * Where the instance's own output starts in the build log: rollout.sh's
 * errors (setup, migrations), deploy.sh's last lines of a container that
 * crashed, and the error lines of an app that is up (deploy.sh).
 */
export const INSTANCE_OUTPUT =
  /--- errors from the instance ---|=== \S+ did not stay up|=== error lines in the app's startup log ===/;

interface Context {
  /** The database is the owner's (hosted outside AWS): its settings are the values they entered. */
  databaseExternal: boolean;
  /** What applies a corrected setting: Retry after a failure, Redeploy once the app is live. */
  next?: "Retry" | "Redeploy";
  /** Settings the code reads that have no value (not entered, not set by AutoInfra). */
  unsetEnv?: string[];
  /** The rollout failed (not an app that came up with errors in its log). */
  failed?: boolean;
}

const yours = (ctx: Context, what: string) =>
  ctx.databaseExternal
    ? `For a database outside AWS these are the values you entered: correct ${what} under Environment variables, then ${ctx.next ?? "Retry"}.`
    : `AutoInfra sets these itself for its database, so the app is likely using values written into its code instead of ${what}.`;

/** The commonest reasons an app can't start, in its own words, made plain. */
const KNOWN: Array<[RegExp, (m: RegExpMatchArray, ctx: Context) => string]> = [
  [
    /password authentication failed for user ["']?([^"'\s]+)/i,
    (m, ctx) =>
      `The database refused the app's password for user "${m[1]}". ${yours(ctx, "DB_PASSWORD (or the password in DATABASE_URL)")}`,
  ],
  [
    /Access denied for user '([^']+)'/i,
    (m, ctx) =>
      `The MySQL database refused the app's login for "${m[1]}". ${yours(ctx, "the database user and password")}`,
  ],
  [
    /bad auth|MongoServerError: Authentication failed/i,
    (_m, ctx) =>
      `MongoDB refused the app's login. ${yours(ctx, "the user and password in MONGODB_URI")}`,
  ],
  [
    /no pg_hba\.conf entry .*(?:SSL off|no encryption)|connection is insecure|sslmode=require/i,
    (_m, ctx) =>
      `The database only accepts encrypted connections: turn SSL on in the app's database settings (DB_SSL, or ?sslmode=require in DATABASE_URL), then ${ctx.next ?? "Retry"}.`,
  ],
  [
    /database "([^"]+)" does not exist|Unknown database '([^']+)'/i,
    (m) =>
      `The database "${m[1] ?? m[2]}" doesn't exist on that server: check the database name (DB_NAME, or the name in DATABASE_URL).`,
  ],
  [
    /relation "([^"]+)" does not exist|Table '([^']+)' doesn't exist/i,
    (m, ctx) =>
      `The database has no "${m[1] ?? m[2]}" table yet: load the app's schema into it first (its schema.sql or setup script), then ${ctx.next ?? "Retry"}.`,
  ],
  [
    // mongodb+srv:// looks the cluster up as _mongodb._tcp.<host> (querySrv).
    /(?:getaddrinfo|querySrv) (?:ENOTFOUND|EAI_AGAIN) (?:_[\w-]+\._tcp\.)?([\w.-]+)/i,
    (m) =>
      `The app couldn't find the host "${m[1]}": check the address in its settings (a typo, or a host that only exists on a developer's machine).`,
  ],
  [
    /connect (?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH) (?:127\.0\.0\.1|::1|localhost)[:\d]*/i,
    () =>
      "The app connects to localhost, which inside its container is the app itself: it has to read the address from its settings.",
  ],
  [
    /connect (?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH) ([\w.:[\]-]+)/i,
    (m) =>
      `Nothing answered at ${m[1]}: the server is down, the port is wrong, or its firewall doesn't let this instance in.`,
  ],
  [
    // passport's Google/GitHub strategies check their options when the app starts.
    /OAuth2Strategy requires a clientID option/,
    (_m, ctx) => {
      const ids = (ctx.unsetEnv ?? []).filter((n) => /CLIENT_ID$/.test(n));
      return `A sign-in method (Google, GitHub... through passport) needs its client ID when the app starts, even if nobody uses it: set ${ids.length ? ids.join(" and ") : "the provider's client ID"} under Environment variables -- your OAuth app's value, or any placeholder to leave that sign-in off -- then ${ctx.next ?? "Retry"}.`;
    },
  ],
  [
    /Cannot find module '([^']+)'/,
    (m) =>
      `The app couldn't load "${m[1]}": a dependency missing from package.json, or a start command pointing at a file that isn't there.`,
  ],
  [
    /JavaScript heap out of memory|OOMKilled|Out of memory: Killed/i,
    () => "The app ran out of memory on the instance (1 GB for every container together).",
  ],
];

/**
 * A build that failed for a reason that isn't the app's: Docker Hub refusing
 * to send an image to CodeBuild's shared addresses (AutoInfra's own images
 * come from AWS's mirror, but a repo's Dockerfile may name others).
 */
export function buildFailure(buildLines: string[]): string | undefined {
  const refused = buildLines.some(
    (line) => /429 Too Many Requests|toomanyrequests/i.test(line) && /docker\.io/i.test(line),
  );
  return refused
    ? "Docker Hub refused to send an image (429 Too Many Requests): it limits pulls from the shared addresses CodeBuild builds from. Nothing is wrong with the app -- Retry in a few minutes."
    : undefined;
}

/**
 * A plain reason for a failed rollout, from the lines the instance printed
 * after it failed -- undefined when none of the known causes matches (the
 * build log, and "Explain this failure", are there for the rest).
 */
export function startupFailure(instanceLines: string[], ctx: Context): string | undefined {
  for (const line of instanceLines) {
    for (const [pattern, reason] of KNOWN) {
      const match = line.match(pattern);
      if (match) return reason(match, ctx);
    }
  }
  // Not a cause it knows, but the app itself crashed (not a setup step) and
  // some settings it reads are empty: a missing one is the likeliest cause.
  const unset = ctx.unsetEnv ?? [];
  const crashed = instanceLines.some((line) => /=== \S+ did not stay up/.test(line));
  if (ctx.failed && crashed && unset.length) {
    const named =
      unset.slice(0, 8).join(", ") + (unset.length > 8 ? ` and ${unset.length - 8} more` : "");
    return `The app stopped at startup (its log is above), and it reads settings that have no value: ${named}. A missing one is the usual cause -- set them under Environment variables, then Retry.`;
  }
  return undefined;
}
