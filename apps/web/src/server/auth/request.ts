import type { NextRequest } from "next/server";
import { equalText } from "@/server/auth/crypto";
import { environment } from "@/server/environment";
import { currentSession } from "@/server/auth/sessions";
import type { Permission } from "@situation-studio/domain";

export function validMutationBoundary(request: NextRequest): boolean {
  const expected = environment();
  return (
    request.headers.get("host") === expected.SITUATION_STUDIO_HOST &&
    request.headers.get("origin") === expected.SITUATION_STUDIO_ORIGIN
  );
}

export async function authenticateMutation(
  request: NextRequest,
  permission?: Permission,
) {
  if (!validMutationBoundary(request))
    return { ok: false as const, status: 403 as const };
  const session = await currentSession();
  if (!session) return { ok: false as const, status: 401 as const };
  const csrf = request.headers.get("x-csrf-token") ?? "";
  if (!equalText(csrf, session.csrfToken))
    return { ok: false as const, status: 403 as const };
  if (permission && !session.permissions.has(permission))
    return { ok: false as const, status: 403 as const };
  return { ok: true as const, session };
}
