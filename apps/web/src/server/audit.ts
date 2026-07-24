import type { Prisma } from "@situation-studio/db";
import { database } from "@/server/database";

const forbidden = /password|secret|token|credential|authorization|cookie/iu;

function safePayload(payload: Record<string, unknown>) {
  for (const key of Object.keys(payload))
    if (forbidden.test(key))
      throw new Error(`Sensitive audit payload key is forbidden: ${key}.`);
  return payload as Prisma.InputJsonValue;
}

export function recordAudit(input: {
  actorId?: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown>;
}) {
  return database().auditEvent.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: safePayload(input.payload ?? {}),
    },
  });
}
