/**
 * GitHub login doesn't grant email access (scope is read:user, not
 * user:email), so a GitHub-only account gets a synthetic address on the
 * RFC 2606 reserved `.invalid` TLD. Nobody can sign in with it.
 */
const PLACEHOLDER_DOMAIN = "users.autoinfra.invalid";

export function placeholderEmail(githubUserId: number | string): string {
  return `github-${githubUserId}@${PLACEHOLDER_DOMAIN}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith(".invalid");
}
