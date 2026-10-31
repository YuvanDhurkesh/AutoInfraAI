import { describe, expect, it } from "vitest";
import { parseEnvPaste } from "./env-paste.js";

// conduit-realworld-example-app's backend/.env.example, exactly as published.
const CONDUIT = `## Environment Variables
PORT=3001
JWT_KEY=supersecretkey_example

## Development Database
DEV_DB_USERNAME=root
DEV_DB_PASSWORD=null
DEV_DB_NAME=database_development
DEV_DB_HOSTNAME=127.0.0.1
DEV_DB_DIALECT=mysql
DEV_DB_LOGGGIN=true

## Production Database
PROD_DB_USERNAME=root
PROD_DB_PASSWORD=null
PROD_DB_NAME=database_production
PROD_DB_HOSTNAME=127.0.0.1
PROD_DB_DIALECT=mysql
PROD_DB_LOGGGIN=false
`;

describe("parseEnvPaste", () => {
  it("a real env template: AutoInfra's own settings and PORT left out, the example secret not used", () => {
    const provided = new Set(
      ["DEV", "PROD"].flatMap((env) =>
        ["USERNAME", "PASSWORD", "NAME", "HOSTNAME", "DIALECT"].map((p) => `${env}_DB_${p}`),
      ),
    );
    const pasted = parseEnvPaste(CONDUIT, provided);
    expect(pasted.rows).toEqual([
      { name: "JWT_KEY", value: "", isSecret: true },
      { name: "DEV_DB_LOGGGIN", value: "true", isSecret: false },
      { name: "PROD_DB_LOGGGIN", value: "false", isSecret: false },
    ]);
    expect(pasted.needsOwnValue).toEqual(["JWT_KEY"]);
    expect(pasted.skipped).toContainEqual({ name: "PORT", reason: "reserved" });
    expect(pasted.skipped).toContainEqual({ name: "PROD_DB_HOSTNAME", reason: "set_by_autoinfra" });
    expect(pasted.skipped.filter((s) => s.reason === "set_by_autoinfra")).toHaveLength(10);
  });

  it("dotenv syntax: export, quotes, inline comments, the last line winning", () => {
    const pasted = parseEnvPaste(
      [
        "export STRIPE_KEY=sk_live_abc123",
        'GREETING="hello # not a comment"',
        "SITE_NAME='My Shop'",
        "MAX_ITEMS=50 # per page",
        "MAX_ITEMS=60",
        // A quoted value with a comment after it: the quotes aren't part of it.
        'DB_PASSWORD="npg_Abc123XyZ" # Neon',
        "API_TOKEN='tok-9f2k4LmQ' # rotate yearly",
        "not a variable line",
        "BAD-NAME=1",
      ].join("\r\n"),
      new Set(),
    );
    expect(pasted.rows).toEqual([
      { name: "STRIPE_KEY", value: "sk_live_abc123", isSecret: true },
      { name: "GREETING", value: "hello # not a comment", isSecret: false },
      { name: "SITE_NAME", value: "My Shop", isSecret: false },
      { name: "MAX_ITEMS", value: "60", isSecret: false },
      { name: "DB_PASSWORD", value: "npg_Abc123XyZ", isSecret: true },
      { name: "API_TOKEN", value: "tok-9f2k4LmQ", isSecret: true },
    ]);
    expect(pasted.skipped).toEqual([{ name: "BAD-NAME", reason: "invalid_name" }]);
    expect(pasted.needsOwnValue).toEqual([]);
  });

  it("placeholder and weak secrets are never filled in", () => {
    const pasted = parseEnvPaste(
      "SESSION_SECRET=changeme\nAPI_TOKEN=<your-token>\nDB_PASSWORD=password\nAPP_KEY=\nREAL_KEY=8f3k2LqW9zP0vT6x",
      new Set(),
    );
    expect(pasted.needsOwnValue).toEqual(["SESSION_SECRET", "API_TOKEN", "DB_PASSWORD", "APP_KEY"]);
    expect(pasted.rows.find((r) => r.name === "REAL_KEY")?.value).toBe("8f3k2LqW9zP0vT6x");
  });
});
