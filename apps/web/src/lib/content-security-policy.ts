const defaultCandidateOrigin = "https://leadership.timsprototypes.com";

export function candidateFormActionOrigin(configured?: string) {
  try {
    return new URL(configured ?? defaultCandidateOrigin).origin;
  } catch {
    return defaultCandidateOrigin;
  }
}

export function studioContentSecurityPolicy(
  nonce: string,
  configuredCandidateOrigin?: string,
) {
  const candidateOrigin = candidateFormActionOrigin(configuredCandidateOrigin);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action 'self' ${candidateOrigin}`,
    "frame-ancestors 'none'",
  ].join("; ");
}
