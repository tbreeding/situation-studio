import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const identities = {
  content: {
    archive: path.join(
      root,
      "vendor/leadership-field-guide-content-contracts-0.2.0.tgz",
    ),
    runtime: path.join(
      root,
      "apps/publisher/node_modules/@leadership-field-guide/content-contracts/dist/index.js",
    ),
    digest: "6441251640d45ac3b5280a8e586c108e0e678612c13f7421566b342326321aba",
    version: "0.2.0",
    validationPolicyHash:
      "4485b61546c3abbc4d9dc1540d9a639eb7c765501246bd361a7ccd81a31de01e",
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
  content.validationPolicyHash !== identities.content.validationPolicyHash
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
    },
    situationContract: {
      version: identities.situation.version,
      packageSha256: identities.situation.digest,
    },
  }),
);
