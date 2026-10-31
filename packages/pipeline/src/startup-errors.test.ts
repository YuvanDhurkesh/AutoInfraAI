import { describe, expect, it } from "vitest";
import { buildFailure, INSTANCE_OUTPUT, startupFailure } from "./startup-errors.js";

const outside = { databaseExternal: true };
const own = { databaseExternal: false };

describe("startupFailure", () => {
  it("Farmer_Connect on Neon: the password the owner entered was refused", () => {
    // The instance's output, as rollout.sh printed it on the real deployment.
    const lines = [
      "--- errors from the instance ---",
      " Network autoinfra_default  Created",
      "❌ PostgreSQL connection error: password authentication failed for user 'neondb_owner'",
      "Migration failed: error: password authentication failed for user 'neondb_owner'",
    ];
    expect(INSTANCE_OUTPUT.test(lines[0]!)).toBe(true);
    expect(startupFailure(lines, outside)).toBe(
      'The database refused the app\'s password for user "neondb_owner". For a database outside AWS these are the values you entered: correct DB_PASSWORD (or the password in DATABASE_URL) under Environment variables, then Retry.',
    );
  });

  it("with AutoInfra's own database, a refused login points at credentials written into the code", () => {
    expect(
      startupFailure(
        ["Error: Access denied for user 'root'@'172.18.0.3' (using password: YES)"],
        own,
      ),
    ).toMatch(
      /^The MySQL database refused the app's login for "root"\. AutoInfra sets these itself/,
    );
  });

  it.each([
    ['error: relation "users" does not exist', /no "users" table yet: load the app's schema/],
    ['error: database "farmers" does not exist', /The database "farmers" doesn't exist/],
    [
      "Error: getaddrinfo ENOTFOUND ep-cool-name.neon.tech",
      /couldn't find the host "ep-cool-name\.neon\.tech"/,
    ],
    ["Error: connect ECONNREFUSED 127.0.0.1:5432", /connects to localhost/],
    ["Error: connect ETIMEDOUT 34.120.1.9:5432", /Nothing answered at 34\.120\.1\.9:5432/],
    ["MongoServerError: bad auth : authentication failed", /MongoDB refused the app's login/],
    [
      "error: connection is insecure (try using `sslmode=require`)",
      /only accepts encrypted connections/,
    ],
    ["Error: Cannot find module '/app/dist/server.js'", /couldn't load "\/app\/dist\/server\.js"/],
    [
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      /ran out of memory/,
    ],
  ])("%s", (line, reason) => {
    expect(startupFailure([line], outside)).toMatch(reason);
  });

  it("an error it doesn't know is left to the build log and Explain this failure", () => {
    expect(startupFailure(["TypeError: x is not a function"], outside)).toBeUndefined();
    expect(startupFailure([], outside)).toBeUndefined();
  });
});

describe("buildFailure", () => {
  it("CareerLens' build: Docker Hub refused CodeBuild's address", () => {
    const line =
      "#2 ERROR: failed to copy: httpReadSeeker: failed open: unexpected status from GET request to https://registry-1.docker.io/v2/library/node/manifests/sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd: 429 Too Many Requests";
    expect(buildFailure(["npm run build", line])).toMatch(/^Docker Hub refused to send an image/);
    expect(
      buildFailure(["npm ERR! 429 Too Many Requests - GET https://registry.npmjs.org/x"]),
    ).toBe(undefined);
  });
});

describe("an app that is up but can't reach its database", () => {
  it("CareerLens: its Atlas cluster's address doesn't exist (mongodb+srv lookup)", () => {
    const lines = [
      "=== error lines in the app's startup log ===",
      "app-1  | ❌ MongoDB Connection Error: querySrv ENOTFOUND _mongodb._tcp.cluster0.dqbopmt.mongodb.net",
    ];
    expect(INSTANCE_OUTPUT.test(lines[0]!)).toBe(true);
    expect(startupFailure(lines, { databaseExternal: true, next: "Redeploy" })).toBe(
      "The app couldn't find the host \"cluster0.dqbopmt.mongodb.net\": check the address in its settings (a typo, or a host that only exists on a developer's machine).",
    );
    // Once live, a corrected setting takes a Redeploy, not a Retry.
    expect(
      startupFailure(["error: password authentication failed for user 'app'"], {
        databaseExternal: true,
        next: "Redeploy",
      }),
    ).toMatch(/then Redeploy\.$/);
  });
});

describe("settings the app reads that have no value", () => {
  // CareerLens with only GEMINI_API_KEY and JWT_SECRET entered.
  const unsetEnv = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_CALLBACK_URL",
  ];

  it("CareerLens: passport's Google strategy needs its client ID at startup", () => {
    const lines = [
      "=== app did not stay up. Its last log lines: ===",
      "app-1  | TypeError: OAuth2Strategy requires a clientID option",
      "app-1  |     at configurePassport (file:///app/config/passport.js:8:5)",
    ];
    expect(startupFailure(lines, { databaseExternal: false, unsetEnv, failed: true })).toBe(
      "A sign-in method (Google, GitHub... through passport) needs its client ID when the app starts, even if nobody uses it: set GOOGLE_CLIENT_ID and GITHUB_CLIENT_ID under Environment variables -- your OAuth app's value, or any placeholder to leave that sign-in off -- then Retry.",
    );
  });

  it("a crash it doesn't recognise names the empty settings, but only when the rollout failed", () => {
    const lines = [
      "=== app did not stay up. Its last log lines: ===",
      "TypeError: x is not a function",
    ];
    expect(startupFailure(lines, { databaseExternal: false, unsetEnv, failed: true })).toMatch(
      /^The app stopped at startup \(its log is above\), and it reads settings that have no value: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, /,
    );
    // A live app's error lines aren't a crash: no guessing there.
    expect(startupFailure(lines, { databaseExternal: false, unsetEnv })).toBeUndefined();
    expect(
      startupFailure(lines, { databaseExternal: false, unsetEnv: [], failed: true }),
    ).toBeUndefined();
  });
});

describe("a setup step that failed is not blamed on empty settings", () => {
  it("Farmer_Connect: the migration ran before the database was up", () => {
    const lines = [
      "--- errors from the instance ---",
      " db Pulled",
      'service "db" is not running',
      "failed to run commands: exit status 1",
    ];
    expect(
      startupFailure(lines, {
        databaseExternal: false,
        unsetEnv: ["TWILIO_SID", "TWILIO_AUTH", "TWILIO_PHONE"],
        failed: true,
      }),
    ).toBeUndefined();
  });
});
