import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REVIEW_POLICY_SOURCE_HASH, REVIEW_POLICY_VERSION } from "./version";

type PolicyManifest = {
  schemaVersion: "review-policy-snapshot-v1";
  policyName: "review-leadership-situations";
  version: string;
  sourceHash: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};

const policyRoot = new URL("../policy/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", policyRoot), "utf8"),
) as PolicyManifest;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

if (
  manifest.schemaVersion !== "review-policy-snapshot-v1" ||
  manifest.policyName !== "review-leadership-situations" ||
  manifest.version !== REVIEW_POLICY_VERSION ||
  manifest.sourceHash !== REVIEW_POLICY_SOURCE_HASH
)
  throw new Error("The packaged leadership-review policy manifest is invalid.");

const documents = new Map(
  manifest.files.map((file) => {
    const body = readFileSync(new URL(file.path, policyRoot), "utf8");
    if (
      Buffer.byteLength(body, "utf8") !== file.bytes ||
      sha256(body) !== file.sha256
    )
      throw new Error(
        `The packaged review-policy file is invalid: ${file.path}`,
      );
    return [file.path, body] as const;
  }),
);

function document(relativePath: string) {
  const body = documents.get(relativePath);
  if (!body)
    throw new Error(
      `The packaged review-policy file is missing: ${relativePath}`,
    );
  return body;
}

function section(relativePath: string, heading: string) {
  const lines = document(relativePath).split("\n");
  const marker = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0)
    throw new Error(
      `The packaged review policy is missing "${heading}" in ${relativePath}.`,
    );
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function combine(...parts: string[]) {
  return parts.filter(Boolean).join("\n\n");
}

const studioOutputAdapter = `## Situation Studio output adapter

The packaged policy is authoritative for review substance and decision fields.
The enforced Situation Studio JSON schema is authoritative for transport. Put
the policy contract's complete substance into the structured summary and
findings. Use one finding per material blocker or decision. Preserve exact
contract labels in the summary when the policy requires a named field. Never
drop a required decision merely because the transport schema is more general.`;

const lensByRole: Record<string, string> = {
  "critic-nvc": "Nonviolent Communication and power/request clarity",
  "critic-negotiation": "Tactical empathy and negotiation",
  "critic-coaching": "Coaching and curiosity",
  "critic-team-health": "Team health and organizational clarity",
  "critic-radical-candor": "Care plus direct challenge",
  "critic-change-systems": "Systems, upstream prevention, and behavior change",
  "critic-manager-tools":
    "Management operating cadence and behavioral feedback",
  "rebuttal-nvc": "Nonviolent Communication and power/request clarity",
  "rebuttal-negotiation": "Tactical empathy and negotiation",
  "rebuttal-coaching": "Coaching and curiosity",
  "rebuttal-team-health": "Team health and organizational clarity",
  "rebuttal-radical-candor": "Care plus direct challenge",
  "rebuttal-change-systems":
    "Systems, upstream prevention, and behavior change",
  "rebuttal-manager-tools":
    "Management operating cadence and behavioral feedback",
};

function frameworkPolicy(role: string) {
  const lens = lensByRole[role];
  if (!lens) throw new Error(`No framework policy is defined for ${role}.`);
  return combine(
    section("references/framework-lenses.md", "Shared tests"),
    section("references/framework-lenses.md", lens),
  );
}

function criticPolicy(role: string) {
  return combine(
    section("SKILL.md", "Run seven blind reviews"),
    frameworkPolicy(role),
    section("references/agent-contracts.md", "Common critic prompt"),
    section("references/agent-contracts.md", "Critic output"),
  );
}

function rebuttalPolicy(role: string) {
  return combine(
    section("SKILL.md", "Mediate one debate round"),
    frameworkPolicy(role),
    section("references/agent-contracts.md", "Rebuttal prompt and output"),
  );
}

export function reviewPolicyForRole(
  role: string,
  requestedVersion = REVIEW_POLICY_VERSION,
) {
  if (requestedVersion !== REVIEW_POLICY_VERSION)
    throw new Error(
      `Review policy ${requestedVersion} is unavailable; this release contains ${REVIEW_POLICY_VERSION}.`,
    );

  let rolePolicy: string;
  if (role.startsWith("critic-")) rolePolicy = criticPolicy(role);
  else if (role.startsWith("rebuttal-")) rolePolicy = rebuttalPolicy(role);
  else {
    switch (role) {
      case "surface-mapper":
        rolePolicy = combine(
          section("SKILL.md", "Preflight the target"),
          section(
            "references/leadership-field-guide.md",
            "Required situation structure",
          ),
          section(
            "references/leadership-field-guide.md",
            "Learning-surface graph",
          ),
        );
        break;
      case "issue-register":
        rolePolicy = combine(
          section("SKILL.md", "Mediate one debate round"),
          section("references/agent-contracts.md", "Issue register"),
        );
        break;
      case "adjudicator":
        rolePolicy = combine(
          section("SKILL.md", "Adjudicate the handling strategy"),
          section(
            "references/agent-contracts.md",
            "Adjudicator prompt and output",
          ),
          section(
            "references/plain-global-english.md",
            "Separate private reasoning from public teaching",
          ),
          section("references/plain-global-english.md", "Set a concept budget"),
        );
        break;
      case "teaching-designer":
        rolePolicy = combine(
          section("SKILL.md", "Translate the decision into teaching"),
          section(
            "references/agent-contracts.md",
            "Teaching designer prompt and output",
          ),
          document("references/teaching-alignment.md"),
          document("references/plain-global-english.md"),
        );
        break;
      case "bundle-writer":
        rolePolicy = combine(
          section("SKILL.md", "Translate the decision into teaching"),
          document("references/plain-global-english.md"),
          section(
            "references/leadership-field-guide.md",
            "Voice and substantive constraints",
          ),
          section(
            "references/leadership-field-guide.md",
            "Sources, originality, and field notes",
          ),
        );
        break;
      case "audit-semantic":
        rolePolicy = combine(
          section("SKILL.md", "Translate the decision into teaching"),
          section(
            "references/agent-contracts.md",
            "Post-draft semantic auditor",
          ),
        );
        break;
      case "audit-teaching-alignment":
        rolePolicy = combine(
          document("references/teaching-alignment.md"),
          document("references/plain-global-english.md"),
          section(
            "references/agent-contracts.md",
            "Post-draft teaching auditor",
          ),
        );
        break;
      case "audit-repository-integrity":
        rolePolicy = combine(
          document("references/leadership-field-guide.md"),
          section(
            "references/agent-contracts.md",
            "Post-draft repository auditor",
          ),
        );
        break;
      case "audit-page-language":
        rolePolicy = combine(
          document("references/plain-global-english.md"),
          section(
            "references/agent-contracts.md",
            "Post-draft page-language and cognitive-load auditor",
          ),
        );
        break;
      case "deterministic-validator":
        rolePolicy = `## Deterministic validator

The worker has already run the deterministic bundle schema and hash checks.
Return a concise PASS summary with no findings. Do not perform another editorial
review and do not propose changes.`;
        break;
      default:
        throw new Error(`No packaged review policy is defined for ${role}.`);
    }
  }

  return combine(
    `## Packaged review policy\n\nPolicy version: ${REVIEW_POLICY_VERSION}`,
    studioOutputAdapter,
    rolePolicy,
  );
}

export { REVIEW_POLICY_SOURCE_HASH, REVIEW_POLICY_VERSION };
