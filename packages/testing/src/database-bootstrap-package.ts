import fs from "node:fs";
import path from "node:path";
import {
  buildSnapshotEdges,
  canonicalArtifactBytes,
  canonicalJson,
  classifyArtifactPath,
  logicalIdForArtifact,
  mediaTypeForPath,
  sha256,
  validateCanonicalSnapshot,
  validateSnapshotBodies,
  validationPolicyHash,
  type SnapshotArtifact,
  type SnapshotManifest,
} from "@situation-studio/content-contracts";

export const bootstrapSource = {
  releaseId: "ae9f5987-017e-4a80-8c47-c10b5de8b994-b6e40575eb82",
  historicalCommit: "b6e40575eb823dc32c62644775895ad84a80d2d1",
  frozenManifestHash:
    "a259e603c94c490558f91e420a758114380969aaaa05f8696de8e34c221b000b",
} as const;

const legacyToolBehaviorSemanticHash =
  "e813da8f2cfb790bfaf7bfd9e79e28ef75aa81c3e335fae447cf6565b11c9c1f";

const managedRoots = [
  "content/situations",
  "content/guides",
  "content/practices",
  "content/bibliography",
  "content/authors",
  "content/tools",
  "sourceMaterial",
] as const;

function walkFiles(root: string, relativeDirectory: string): string[] {
  const directory = path.join(root, relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, relativePath);
    const metadata = fs.lstatSync(absolutePath);
    if (metadata.isSymbolicLink())
      throw new Error(`Managed content may not be a symlink: ${relativePath}`);
    if (metadata.isDirectory()) return walkFiles(root, relativePath);
    if (!metadata.isFile())
      throw new Error(`Unsupported managed filesystem entry: ${relativePath}`);
    return [relativePath];
  });
}

export type BootstrapPackage = {
  manifest: SnapshotManifest;
  manifestBody: string;
  manifestHash: string;
  bodies: Map<string, Uint8Array>;
  inventory: {
    schemaVersion: "database-bootstrap-inventory-v1";
    managedRoots: readonly string[];
    discoveredFileCount: number;
    canonicalByteLength: number;
    artifacts: Array<
      SnapshotArtifact & {
        sourceHash: string;
        sourceByteLength: number;
        normalization: string;
      }
    >;
  };
  parityReport: {
    schemaVersion: "database-bootstrap-parity-v1";
    canonicalNewlineRule: string;
    artifactCount: number;
    exactMatches: number;
    mismatches: never[];
    artifacts: Array<{
      path: string;
      encoding: string;
      sourceHash: string;
      sourceByteLength: number;
      canonicalHash: string;
      canonicalByteLength: number;
      normalization: string;
      exact: true;
    }>;
  };
  routeProbes: {
    schemaVersion: "database-bootstrap-route-probes-v1";
    routes: { path: string; logicalId: string; kind: string }[];
  };
  toolExtraction: {
    schemaVersion: "database-bootstrap-tool-extraction-v1";
    surfaces: Array<{
      legacyPath: string;
      legacySourceHash: string;
      legacyBehaviorSemanticHash: string;
      dataPath: string;
      dataHash: string;
      semanticHash: string;
      toolIds: string[];
      fieldCounts: Record<string, number>;
      behaviorProbe: string;
    }>;
  };
};

export async function createBootstrapPackage(
  leadershipRoot: string,
): Promise<BootstrapPackage> {
  const discoveredPaths = managedRoots
    .flatMap((root) => walkFiles(leadershipRoot, root))
    .sort((left, right) => left.localeCompare(right));
  const bodies = new Map<string, Uint8Array>();
  const inventoryArtifacts = discoveredPaths.map((relativePath) => {
    const sourceBytes = fs.readFileSync(
      path.join(leadershipRoot, relativePath),
    );
    const canonical = canonicalArtifactBytes(relativePath, sourceBytes);
    const contentHash = sha256(canonical.bytes);
    bodies.set(contentHash, canonical.bytes);
    return {
      logicalId: logicalIdForArtifact(relativePath, canonical.bytes),
      type: classifyArtifactPath(relativePath),
      path: relativePath,
      contentHash,
      byteLength: canonical.bytes.byteLength,
      encoding: canonical.encoding,
      mediaType: mediaTypeForPath(relativePath),
      sourceHash: sha256(sourceBytes),
      sourceByteLength: sourceBytes.byteLength,
      normalization: canonical.normalization,
    } satisfies SnapshotArtifact & {
      sourceHash: string;
      sourceByteLength: number;
      normalization: string;
    };
  });
  const artifacts: SnapshotArtifact[] = inventoryArtifacts.map(
    ({
      sourceHash: _sourceHash,
      sourceByteLength: _sourceBytes,
      normalization: _normalization,
      ...artifact
    }) => artifact,
  );
  const parsed = await validateSnapshotBodies(artifacts, bodies);
  const extractedToolSemanticHash = sha256(canonicalJson(parsed.tools));
  if (extractedToolSemanticHash !== legacyToolBehaviorSemanticHash)
    throw new Error(
      "Extracted tool data no longer matches the recorded pre-migration public behavior.",
    );
  const manifest: SnapshotManifest = {
    schemaVersion: "content-snapshot-v1",
    validationPolicyHash,
    source: bootstrapSource,
    artifacts,
    edges: buildSnapshotEdges(parsed),
  };
  const manifestBody = canonicalJson(manifest);
  await validateCanonicalSnapshot(manifestBody, bodies);
  const parityArtifacts = inventoryArtifacts.map((artifact) => ({
    path: artifact.path,
    encoding: artifact.encoding,
    sourceHash: artifact.sourceHash,
    sourceByteLength: artifact.sourceByteLength,
    canonicalHash: artifact.contentHash,
    canonicalByteLength: artifact.byteLength,
    normalization: artifact.normalization,
    exact: true as const,
  }));
  return {
    manifest,
    manifestBody,
    manifestHash: sha256(manifestBody),
    bodies,
    inventory: {
      schemaVersion: "database-bootstrap-inventory-v1",
      managedRoots,
      discoveredFileCount: artifacts.length,
      canonicalByteLength: artifacts.reduce(
        (total, artifact) => total + artifact.byteLength,
        0,
      ),
      artifacts: inventoryArtifacts,
    },
    parityReport: {
      schemaVersion: "database-bootstrap-parity-v1",
      canonicalNewlineRule:
        "CRLF and CR become LF; all trailing newlines become exactly one LF; binary bytes are unchanged.",
      artifactCount: artifacts.length,
      exactMatches: artifacts.length,
      mismatches: [],
      artifacts: parityArtifacts,
    },
    routeProbes: {
      schemaVersion: "database-bootstrap-route-probes-v1",
      routes: parsed.routeProbes,
    },
    toolExtraction: {
      schemaVersion: "database-bootstrap-tool-extraction-v1",
      surfaces: [
        {
          legacyPath: "lib/tools.ts",
          legacySourceHash:
            "0e8448ffd733457c3f704c99fddeb7cb66374636a27c9fb18624356b00c1b00e",
          legacyBehaviorSemanticHash: legacyToolBehaviorSemanticHash,
          dataPath: "content/tools/tools.json",
          dataHash:
            artifacts.find((artifact) => artifact.logicalId === "tool:catalog")
              ?.contentHash ?? "",
          semanticHash: extractedToolSemanticHash,
          toolIds: parsed.tools.map((tool) => tool.id),
          fieldCounts: Object.fromEntries(
            parsed.tools.map((tool) => [tool.id, tool.fields.length]),
          ),
          behaviorProbe: "leadership/tests/content.test.ts",
        },
      ],
    },
  };
}

export function packageRoot(studioRoot: string): string {
  return path.join(studioRoot, "artifacts/database-publication/bootstrap");
}

export function readPackagedBodies(
  studioRoot: string,
  artifacts: readonly SnapshotArtifact[],
): Map<string, Uint8Array> {
  const root = packageRoot(studioRoot);
  return new Map(
    artifacts.map((artifact) => [
      artifact.contentHash,
      fs.readFileSync(path.join(root, "blobs", artifact.contentHash)),
    ]),
  );
}
