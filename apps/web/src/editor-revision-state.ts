export type EditorRevisionIdentity = {
  id: string;
  bundleHash: string;
};

export function serverRevisionRequiresAdoption(
  local: EditorRevisionIdentity,
  server: EditorRevisionIdentity,
) {
  return local.id !== server.id || local.bundleHash !== server.bundleHash;
}

export function serverRevisionAdoptionDecision(
  local: EditorRevisionIdentity,
  server: EditorRevisionIdentity,
  hasUnsavedLocalEdits: boolean,
) {
  if (!serverRevisionRequiresAdoption(local, server))
    return "UNCHANGED" as const;
  return hasUnsavedLocalEdits
    ? ("PRESERVE_LOCAL" as const)
    : ("ADOPT" as const);
}

export function exactRevisionCommand(revision: EditorRevisionIdentity) {
  return { revisionId: revision.id, bundleHash: revision.bundleHash };
}

export function reviewRequiresForcedCheckpoint(schemaVersion: string) {
  return schemaVersion !== "situation-bundle-v2";
}

export function preflightMatchesRevision(
  receipt: EditorRevisionIdentity,
  revision: EditorRevisionIdentity,
) {
  return (
    receipt.id === revision.id && receipt.bundleHash === revision.bundleHash
  );
}
