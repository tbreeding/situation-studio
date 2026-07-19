export type ObservationKind = "OFFICIAL" | "RESTORATION";

export function observationDeadlineExpired(
  updatedAt: Date,
  deadlineMilliseconds: number,
  now = Date.now(),
) {
  return now - updatedAt.getTime() >= deadlineMilliseconds;
}

export async function requestLeadershipObservation(
  input: {
    url: string;
    triggerSecret: string;
    requestTimeoutMilliseconds: number;
    publicationRequestId: string;
    observationKind: ObservationKind;
  },
  fetchImplementation: typeof fetch = fetch,
) {
  const response = await fetchImplementation(input.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.triggerSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      publicationRequestId: input.publicationRequestId,
      observationKind: input.observationKind,
    }),
    signal: AbortSignal.timeout(input.requestTimeoutMilliseconds),
  });
  if (!response.ok)
    throw new Error(
      `Leadership ${input.observationKind.toLowerCase()} observation failed with ${response.status}.`,
    );
}
