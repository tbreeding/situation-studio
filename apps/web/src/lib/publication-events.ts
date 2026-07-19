export function publicationReplaySequence(value: string | null): bigint {
  return value && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}

export function encodePublicationEvent(event: {
  sequence: bigint;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}) {
  return `id: ${event.sequence}\nevent: publication\ndata: ${JSON.stringify({
    type: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  })}\n\n`;
}
