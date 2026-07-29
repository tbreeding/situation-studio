import { createHash } from "node:crypto";

const url = process.env.LEADERSHIP_RUNTIME_CAPABILITIES_URL;
if (!url) throw new Error("LEADERSHIP_RUNTIME_CAPABILITIES_URL is required.");

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(canonicalValue(value))}\n`)
    .digest("hex");
}

const response = await fetch(url, {
  headers: { accept: "application/json" },
  cache: "no-store",
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok)
  throw new Error(`Leadership capabilities returned ${response.status}.`);
const payload = await response.json();
const { capabilityDigest, ...capabilitySet } = payload;
const requiredFeatures = [
  "authored-physical-id-v1",
  "scoped-renderer-context-v1",
  "typed-projection-parity-v1",
  "affected-route-proof-v2",
];
if (
  payload.schemaVersion !== "leadership-studio-capabilities-v1" ||
  !/^[a-f0-9]{40}$/u.test(payload.deployment?.commit ?? "") ||
  !/^[a-f0-9]{64}$/u.test(payload.deployment?.archiveSha256 ?? "") ||
  payload.contracts?.content?.version !== "0.2.0" ||
  payload.contracts?.content?.packageSha256 !==
    "6441251640d45ac3b5280a8e586c108e0e678612c13f7421566b342326321aba" ||
  payload.contracts?.content?.validationPolicyHash !==
    "4485b61546c3abbc4d9dc1540d9a639eb7c765501246bd361a7ccd81a31de01e" ||
  payload.contracts?.situation?.version !== "1.0.0" ||
  payload.contracts?.situation?.packageSha256 !==
    "9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4" ||
  payload.database?.predicate !== "typed-projection-parity-v1" ||
  requiredFeatures.some((feature) => !payload.features?.includes(feature)) ||
  digest(capabilitySet) !== capabilityDigest
)
  throw new Error("Leadership runtime is not compatible with this Studio.");

console.log(
  JSON.stringify({
    leadershipCommit: payload.deployment.commit,
    capabilityDigest,
  }),
);
