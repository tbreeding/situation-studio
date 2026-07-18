import { randomUUID } from "node:crypto";
import { Prisma } from "@situation-studio/db";
import { database } from "@/server/database";

export async function audit(input: {
  actorId?: string | null;
  actorType?: "HUMAN" | "SERVICE" | "AI";
  permissions?: readonly string[];
  action: string;
  targetType: string;
  targetId?: string | null;
  targetVersion?: string | null;
  outcome: "SUCCEEDED" | "FAILED" | "DENIED";
  reason?: string | null;
  before?: object | null;
  after?: object | null;
  correlationId?: string;
}) {
  const data: Prisma.AuditEventUncheckedCreateInput = {
    actorType: input.actorType ?? "HUMAN",
    actorId: input.actorId ?? null,
    permissionSnapshot: input.permissions ? [...input.permissions] : [],
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    targetVersion: input.targetVersion ?? null,
    correlationId: input.correlationId ?? randomUUID(),
    outcome: input.outcome,
    reason: input.reason ?? null,
    ...(input.before ? { beforeMetadata: input.before } : {}),
    ...(input.after ? { afterMetadata: input.after } : {}),
  };
  await database().auditEvent.create({ data });
}
