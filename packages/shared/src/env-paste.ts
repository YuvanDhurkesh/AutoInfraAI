import { ENV_NAME, RESERVED_ENV_NAME, SECRET_ENV_NAME } from "./env-names.js";

/** A placeholder an env template ships, never a real value (supersecretkey_example, changeme, <your-key>). */
const EXAMPLE_VALUE = /example|change[_-]?me|your[_-]|placeholder|^x{3,}$|^<.*>$|^\*+$|^\.\.\.$/i;
const WEAK_SECRETS = new Set([
  "secret",
  "password",
  "pass",
  "test",
  "null",
  "none",
  "undefined",
  "admin",
  "key",
  "token",
  "123456",
  "12345678",
]);

export interface PastedEnv {
  /** Rows for the form. A secret whose value was a placeholder arrives empty, for the owner to type. */
  rows: Array<{ name: string; value: string; isSecret: boolean }>;
  /** Secrets whose pasted value was a placeholder: anyone reading the repo knows it. */
  needsOwnValue: string[];
  /** Left out, and why. */
  skipped: Array<{ name: string; reason: "set_by_autoinfra" | "reserved" | "invalid_name" }>;
}

/**
 * Reads a pasted .env file (KEY=value lines, comments, `export`, quotes) for
 * the env form. Names AutoInfra sets itself are left out -- an env template's
 * localhost URLs and 127.0.0.1 databases would otherwise replace the values
 * it works out -- and so are reserved ones. The last line for a name wins.
 */
export function parseEnvPaste(text: string, providedNames: ReadonlySet<string>): PastedEnv {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let value = line.slice(eq + 1).trim();
    // A quoted value ends at its closing quote, a comment may follow
    // (PASSWORD="npg_x" # neon); an unquoted one at an inline comment.
    const quoted = value.match(/^(['"])(.*)\1(?:\s+#.*)?$/);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    values.delete(name); // keep the order of the last occurrence
    values.set(name, value);
  }

  const result: PastedEnv = { rows: [], needsOwnValue: [], skipped: [] };
  for (const [name, value] of values) {
    if (!ENV_NAME.test(name)) result.skipped.push({ name, reason: "invalid_name" });
    else if (RESERVED_ENV_NAME.test(name)) result.skipped.push({ name, reason: "reserved" });
    else if (providedNames.has(name)) result.skipped.push({ name, reason: "set_by_autoinfra" });
    else {
      const isSecret = SECRET_ENV_NAME.test(name);
      const placeholder =
        isSecret && (!value || EXAMPLE_VALUE.test(value) || WEAK_SECRETS.has(value.toLowerCase()));
      if (placeholder) result.needsOwnValue.push(name);
      result.rows.push({ name, value: placeholder ? "" : value, isSecret });
    }
  }
  return result;
}
