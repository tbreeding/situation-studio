import fs from "node:fs";
import path from "node:path";
import {
  bundleManifestSchema,
  canonicalBundleHash,
  isApprovedArtifactPath,
  sha256,
  type BundleManifest,
} from "@situation-studio/domain";

const allowedMdxComponents = new Set(["PracticeEmbed", "PreparedAction"]);

export type CandidateFinding = { code: string; path: string; message: string };

export function inspectCandidateText(
  candidatePath: string,
  body: string,
): CandidateFinding[] {
  const findings: CandidateFinding[] = [];
  if (/\0/u.test(body))
    findings.push({
      code: "BINARY_CONTENT",
      path: candidatePath,
      message: "NUL bytes are not allowed.",
    });
  if (/\b(?:javascript|data):/iu.test(body))
    findings.push({
      code: "UNSAFE_URL",
      path: candidatePath,
      message: "Unsafe URL protocol.",
    });
  if (/^\s*(?:import|export)\s/mu.test(body))
    findings.push({
      code: "MDX_MODULE",
      path: candidatePath,
      message: "MDX modules are not allowed in content.",
    });
  if (/<\s*script\b/iu.test(body))
    findings.push({
      code: "SCRIPT_ELEMENT",
      path: candidatePath,
      message: "Script elements are not allowed.",
    });
  for (const match of body.matchAll(/<([A-Z][A-Za-z0-9]*)\b/gu)) {
    const component = match[1];
    if (component && !allowedMdxComponents.has(component))
      findings.push({
        code: "UNKNOWN_COMPONENT",
        path: candidatePath,
        message: `Component ${component} is not allowlisted.`,
      });
  }
  return findings;
}

function resolveInside(root: string, candidate: string) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, candidate);
  if (
    absolute !== absoluteRoot &&
    !absolute.startsWith(`${absoluteRoot}${path.sep}`)
  )
    throw new Error(`PATH_ESCAPE:${candidate}`);
  return absolute;
}

export function validateBundleFiles(
  root: string,
  unknownManifest: unknown,
): { hash: string; findings: CandidateFinding[] } {
  const manifest = bundleManifestSchema.parse(
    unknownManifest,
  ) as BundleManifest;
  const findings: CandidateFinding[] = [];
  for (const artifact of manifest.artifacts) {
    if (!isApprovedArtifactPath(artifact.path)) {
      findings.push({
        code: "PATH_NOT_ALLOWED",
        path: artifact.path,
        message: "Artifact path is outside the allowlist.",
      });
      continue;
    }
    if (artifact.changeKind === "DELETE") continue;
    const absolute = resolveInside(root, artifact.path);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(absolute);
    } catch {
      findings.push({
        code: "MISSING_FILE",
        path: artifact.path,
        message: "Candidate file is missing.",
      });
      continue;
    }
    if (metadata.isSymbolicLink()) {
      findings.push({
        code: "SYMLINK",
        path: artifact.path,
        message: "Candidate symlinks are forbidden.",
      });
      continue;
    }
    if (!metadata.isFile()) {
      findings.push({
        code: "NOT_REGULAR_FILE",
        path: artifact.path,
        message: "Candidate must be a regular file.",
      });
      continue;
    }
    if ((metadata.mode & 0o111) !== 0)
      findings.push({
        code: "EXECUTABLE_MODE",
        path: artifact.path,
        message: "Published content may not be executable.",
      });
    const bytes = fs.readFileSync(absolute);
    if (sha256(bytes) !== artifact.candidateHash)
      findings.push({
        code: "HASH_MISMATCH",
        path: artifact.path,
        message: "Candidate bytes do not match the approved hash.",
      });
    if (/\.(?:md|mdx)$/u.test(artifact.path))
      findings.push(
        ...inspectCandidateText(artifact.path, bytes.toString("utf8")),
      );
  }
  return { hash: canonicalBundleHash(manifest), findings };
}
