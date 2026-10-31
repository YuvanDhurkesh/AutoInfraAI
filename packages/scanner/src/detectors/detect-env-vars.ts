import path from "node:path";
import { SECRET_ENV_NAME as SECRET_NAME_PATTERN } from "@autoinfra/shared";
import { isSourceFile, readFileSafe, walk } from "../fs-utils.js";

export interface DetectedEnvVar {
  name: string;
  isSecret: boolean;
  /** The example's value when it is a local URL (http://localhost:5000/auth/callback). */
  localhostDefault?: string;
  /** The example's or the code's default when it is a listen address (127.0.0.1:8000, :8080). */
  bindDefault?: string;
}

/** Committed templates of the app's .env (never the real one). */
const ENV_EXAMPLE_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  ".env.local.example",
  ".env.development.example",
  "example.env",
  "env.example",
];

/** NAME=value pairs from the folder's env templates, quotes removed. */
export function readEnvExamples(root: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (const file of ENV_EXAMPLE_FILES) {
    const content = readFileSafe(path.join(root, file));
    if (!content) continue;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) {
        const value = match[2]!.replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
        pairs.push({ name: match[1]!, value });
      }
    }
  }
  return pairs;
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/;
/** A loopback or every-interface host, a port, or both: a server's listen address. */
const BIND_ADDRESS =
  /^(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1?|\[::1?\])(?::\d{2,5})?|:\d{2,5})$/;

function fromEnvExample(root: string): DetectedEnvVar[] {
  return readEnvExamples(root).map(({ name, value }) => {
    const isSecret = SECRET_NAME_PATTERN.test(name);
    return {
      name,
      isSecret,
      ...(!isSecret && LOCAL_URL.test(value) ? { localhostDefault: value } : {}),
      ...(!isSecret && BIND_ADDRESS.test(value) ? { bindDefault: value } : {}),
    };
  });
}

/** A default written next to the read: process.env.HOST || "localhost", env::var("ADDRESS").unwrap_or(...). */
const DEFAULT_PATTERNS = [
  /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*["'`]([^"'`\s]+)["'`]/g,
  /os\.(?:environ\.get|getenv)\(\s*["']([A-Z0-9_]+)["']\s*,\s*["']([^"'\s]+)["']/g,
  /env::var\(\s*"([A-Z0-9_]+)"\s*\)\s*\.unwrap_or(?:_else)?\(\s*(?:\|_\|\s*)?"([^"\s]+)"/g,
];

function fromSourceCode(root: string): DetectedEnvVar[] {
  const found = new Set<string>();
  const bindDefaults = new Map<string, string>();
  const patterns = [
    /process\.env\.([A-Z0-9_]+)/g,
    /os\.environ(?:\.get)?\(\s*["']([A-Z0-9_]+)["']/g,
    /os\.environ\[\s*["']([A-Z0-9_]+)["']\s*\]/g,
    /os\.Getenv\(\s*"([A-Z0-9_]+)"/g, // Go
    /System\.getenv\(\s*"([A-Z0-9_]+)"/g, // Java, Kotlin
    /ENV(?:\.fetch\(\s*|\[\s*)["']([A-Z0-9_]+)["']/g, // Ruby
    /\b(?:getenv|env)\(\s*["']([A-Z0-9_]+)["']/g, // PHP, Laravel
    /env::var\(\s*"([A-Z0-9_]+)"/g, // Rust
    /GetEnvironmentVariable\(\s*"([A-Z0-9_]+)"/g, // .NET
    /System\.get_env\(\s*"([A-Z0-9_]+)"/g, // Elixir
  ];
  for (const file of walk(root).filter((f) => isSourceFile(f.relPath))) {
    const content = readFileSafe(file.absPath);
    if (!content) continue;
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        found.add(match[1]!);
      }
    }
    for (const pattern of DEFAULT_PATTERNS) {
      for (const [, name, value] of content.matchAll(pattern)) {
        if (BIND_ADDRESS.test(value!) && !bindDefaults.has(name!)) bindDefaults.set(name!, value!);
      }
    }
  }
  return [...found].map((name) => ({
    name,
    isSecret: SECRET_NAME_PATTERN.test(name),
    ...(bindDefaults.has(name) ? { bindDefault: bindDefaults.get(name)! } : {}),
  }));
}

export function detectEnvVars(root: string): DetectedEnvVar[] {
  const byName = new Map<string, DetectedEnvVar>();
  for (const v of [...fromEnvExample(root), ...fromSourceCode(root)]) {
    const existing = byName.get(v.name);
    byName.set(v.name, {
      name: v.name,
      isSecret: existing?.isSecret || v.isSecret,
      ...((existing?.localhostDefault ?? v.localhostDefault)
        ? { localhostDefault: existing?.localhostDefault ?? v.localhostDefault }
        : {}),
      ...((existing?.bindDefault ?? v.bindDefault)
        ? { bindDefault: existing?.bindDefault ?? v.bindDefault }
        : {}),
    });
  }
  return [...byName.values()];
}
