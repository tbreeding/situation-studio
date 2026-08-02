import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const identities = {
  content: {
    archive: path.join(
      root,
      "vendor/leadership-field-guide-content-contracts-0.3.0.tgz",
    ),
    runtime: path.join(
      root,
      "apps/publisher/node_modules/@leadership-field-guide/content-contracts/dist/index.js",
    ),
    digest: "ef9a723608977b3f9ea3c25bd1a7cd5f323871854937c0e462a21ca057ee9f7f",
    version: "0.3.0",
    validationPolicyHash:
      "9131270fbc6a2e579ee10752fddf3f1f133b257a554666ea946bb76439deceee",
    compilerDigest:
      "5a0b47948760e9134eaac1727bc658de56c87e52bcc9e03db424bb80ea2d4c95",
    validatorDigest:
      "0104cd5e4f02ed5172ca5b7c14e31a694e11319e703cbeb3eec4d226518fc53a",
  },
  situation: {
    archive: path.join(
      root,
      "vendor/leadership-field-guide-situation-contract-1.0.0.tgz",
    ),
    runtime: path.join(
      root,
      "packages/domain/node_modules/@leadership-field-guide/situation-contract/dist/index.js",
    ),
    digest: "9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4",
    version: "leadership-situation-contract-1.0.0",
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

for (const [name, identity] of Object.entries(identities)) {
  const digest = sha256(await fs.readFile(identity.archive));
  if (digest !== identity.digest)
    throw new Error(`${name} contract archive digest differs: ${digest}`);
}

const content = await import(
  `${pathToFileURL(identities.content.runtime).href}?verify=${Date.now()}`
);
if (
  content.CONTENT_CONTRACT_VERSION !== identities.content.version ||
  content.validationPolicyHash !== identities.content.validationPolicyHash ||
  content.PUBLICATION_COMPILER_DIGEST !== identities.content.compilerDigest ||
  content.PUBLISHABLE_SITUATION_VALIDATOR_DIGEST !==
    identities.content.validatorDigest
)
  throw new Error("Resolved content contract identity differs.");

const situation = await import(
  `${pathToFileURL(identities.situation.runtime).href}?verify=${Date.now()}`
);
if (situation.CONTRACT_VERSION !== identities.situation.version)
  throw new Error("Resolved situation contract identity differs.");

console.log(
  JSON.stringify({
    contentContract: {
      version: identities.content.version,
      packageSha256: identities.content.digest,
      validationPolicyHash: identities.content.validationPolicyHash,
      compilerDigest: identities.content.compilerDigest,
      validatorDigest: identities.content.validatorDigest,
    },
    situationContract: {
      version: identities.situation.version,
      packageSha256: identities.situation.digest,
    },
  }),
);
