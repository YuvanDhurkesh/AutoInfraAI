import { readFileSafe, walk } from "../fs-utils.js";

/**
 * Flags *that* a file looks like it contains a secret, never the secret
 * value itself -- these findings get redacted/excluded before anything is
 * sent to Gemini (Milestone 5) or written to logs. A finding here means
 * "a human should look at this file," not "here is the leaked value."
 */
const CONTENT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "possible AWS access key ID", regex: /AKIA[0-9A-Z]{16}/ },
  { label: "possible private key block", regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "possible GitHub token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: "possible Slack token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "possible Stripe live secret key", regex: /sk_live_[A-Za-z0-9]{16,}/ },
];

const ENV_EXAMPLE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);

export function detectSecrets(root: string): string[] {
  const findings: string[] = [];

  for (const file of walk(root)) {
    // Forward slashes on every OS, like every other path in a RepoProfile.
    const rel = file.relPath.split("\\").join("/");
    const base = rel.split("/").pop() ?? "";

    if (/^\.env(\..+)?$/.test(base) && !ENV_EXAMPLE_NAMES.has(base)) {
      const content = readFileSafe(file.absPath);
      if (content && content.trim().length > 0) {
        findings.push(`${rel}: committed .env file with values (should not be in version control)`);
        continue; // don't also content-scan it below -- one finding is enough
      }
    }

    const content = readFileSafe(file.absPath);
    if (!content) continue;
    for (const { label, regex } of CONTENT_PATTERNS) {
      if (regex.test(content)) {
        findings.push(`${rel}: ${label}`);
      }
    }
  }

  return findings;
}
