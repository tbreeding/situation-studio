import { timingSafeEqual } from "node:crypto";

export function trustedBearerMatches(
  secret: string | undefined,
  authorizationHeader: string | null,
) {
  if (!secret || !authorizationHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(authorizationHeader);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function attestationKeyMatches(
  configuredKeyId: string,
  suppliedKeyId: string,
) {
  return configuredKeyId === suppliedKeyId;
}
