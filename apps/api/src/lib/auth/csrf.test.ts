import { describe, expect, it } from "vitest";
import { csrfTokensMatch, generateCsrfToken } from "./csrf.js";

describe("csrf double-submit check", () => {
  it("accepts matching cookie/header tokens", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
  });

  it("rejects a missing header token", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, undefined)).toBe(false);
  });

  it("rejects a missing cookie token", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(undefined, token)).toBe(false);
  });

  it("rejects mismatched tokens", () => {
    expect(csrfTokensMatch(generateCsrfToken(), generateCsrfToken())).toBe(false);
  });
});
