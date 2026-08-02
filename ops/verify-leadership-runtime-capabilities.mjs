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
  "affected-route-proof-json-v1",
];
if (
  payload.schemaVersion !== "leadership-studio-capabilities-v1" ||
  !/^[a-f0-9]{40}$/u.test(payload.deployment?.commit ?? "") ||
  !/^[a-f0-9]{64}$/u.test(payload.deployment?.archiveSha256 ?? "") ||
  payload.contracts?.content?.version !== "0.3.0" ||
  payload.contracts?.content?.packageSha256 !==
    "ef9a723608977b3f9ea3c25bd1a7cd5f323871854937c0e462a21ca057ee9f7f" ||
  payload.contracts?.content?.validationPolicyHash !==
    "9131270fbc6a2e579ee10752fddf3f1f133b257a554666ea946bb76439deceee" ||
  payload.contracts?.publicationCompiler?.digest !==
    "5a0b47948760e9134eaac1727bc658de56c87e52bcc9e03db424bb80ea2d4c95" ||
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
