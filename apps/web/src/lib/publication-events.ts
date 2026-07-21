export function publicationReplaySequence(value: string | null): bigint {
  return value && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}

export type PublicationStreamStatus = {
  state: string;
  currentStep: string;
  updatedAt: string;
  finalConfirmed: boolean;
  serverTime: string;
};

export type PublicationStreamActivity = {
  type: string;
  createdAt: string;
};

function encodeNamedEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function encodePublicationStreamStatus(status: PublicationStreamStatus) {
  return encodeNamedEvent("status", status);
}

export function encodePublicationHeartbeat(status: PublicationStreamStatus) {
  return encodeNamedEvent("heartbeat", status);
}

export function encodePublicationRetry(milliseconds: number) {
  return `retry: ${milliseconds}\n\n`;
}

export function parsePublicationStreamStatus(
  value: string,
): PublicationStreamStatus | null {
  try {
    const candidate = JSON.parse(value) as Partial<PublicationStreamStatus>;
    return typeof candidate.state === "string" &&
      typeof candidate.currentStep === "string" &&
      typeof candidate.updatedAt === "string" &&
      typeof candidate.finalConfirmed === "boolean" &&
      typeof candidate.serverTime === "string"
      ? (candidate as PublicationStreamStatus)
      : null;
  } catch {
    return null;
  }
}

export function parsePublicationActivity(
  value: string,
): PublicationStreamActivity | null {
  try {
    const candidate = JSON.parse(value) as Partial<PublicationStreamActivity>;
    return typeof candidate.type === "string" &&
      typeof candidate.createdAt === "string"
      ? { type: candidate.type, createdAt: candidate.createdAt }
      : null;
  } catch {
    return null;
  }
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
