export function reconcileDisplayedArtifactBody(input: {
  currentBody: string;
  previousArtifactBody: string;
  nextArtifactBody: string;
}) {
  return input.currentBody === input.previousArtifactBody
    ? input.nextArtifactBody
    : input.currentBody;
}
