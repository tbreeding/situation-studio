import { createHmac, timingSafeEqual } from "node:crypto";

const secureCookieNames =
  process.env.SITUATION_STUDIO_ORIGIN?.startsWith("https://") ?? false;

export const CANDIDATE_HANDOFF_STATE_COOKIE = secureCookieNames
  ? "__Host-situation_studio_candidate_handoff"
  : "situation_studio_candidate_handoff_dev";

export type CandidateHandoffProof = {
  expiresAt: string;
  handoffId: string;
  requestId: string;
  requestKind: "publication" | "rollback";
  situationSlug: string;
  state: string;
  verifierHash: string;
};

export function candidateHandoffSignature(
  secret: string,
  proof: CandidateHandoffProof,
) {
  return createHmac("sha256", secret)
    .update(JSON.stringify(proof))
    .digest("hex");
}

export function candidateHandoffSignatureMatches(
  secret: string,
  proof: CandidateHandoffProof,
  supplied: string,
) {
  const expected = Buffer.from(candidateHandoffSignature(secret, proof));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
