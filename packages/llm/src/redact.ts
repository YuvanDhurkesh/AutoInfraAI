import type { RepoProfile } from "@autoinfra/shared";

const MAX_LIST = 25;
const MAX_PROFILE_CHARS = 20_000;

/**
 * What Gemini is allowed to see about a repo (Sec. 5): the scanner's
 * structured findings, never file contents, .env values, or secret
 * locations. Secret findings are reduced to a count -- the model only needs
 * to know "secrets were found, warn the user," not where.
 */
export function redactProfileForLlm(profile: RepoProfile) {
  let repoUrl = profile.repoUrl;
  try {
    const url = new URL(profile.repoUrl);
    url.username = "";
    url.password = "";
    repoUrl = url.toString();
  } catch {
    // keep as-is; it was validated as a URL upstream
  }

  const redacted = {
    repoUrl,
    branch: profile.branch,
    subdir: profile.subdir,
    frontend: profile.frontend && {
      ...profile.frontend,
      hardcodedLocalhostUrls: profile.frontend.hardcodedLocalhostUrls.slice(0, MAX_LIST),
    },
    backend: profile.backend,
    envVarNames: profile.envVars
      .slice(0, MAX_LIST * 2)
      .map((v) => ({ name: v.name, isSecret: v.isSecret })),
    database: profile.database,
    databaseExternal: profile.databaseExternal,
    hasDockerfile: profile.hasDockerfile,
    hasComposeFile: profile.hasComposeFile,
    scannerRecommendedPattern: profile.recommendedPattern,
    secretFindingCount: profile.secretsDetected.length,
  };

  const json = JSON.stringify(redacted);
  if (json.length > MAX_PROFILE_CHARS) {
    return { ...redacted, envVarNames: redacted.envVarNames.slice(0, 10), truncated: true };
  }
  return redacted;
}
