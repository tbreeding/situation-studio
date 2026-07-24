import { redirect } from "next/navigation";
import { safeEqual, sha256 } from "@/server/auth/crypto";
import { currentSession } from "@/server/auth/sessions";

type ActiveSession = NonNullable<Awaited<ReturnType<typeof currentSession>>>;
type MutationSessionResult =
  { error: string; status: 401 | 403 } | { session: ActiveSession };

export async function requireSession(returnTo = "/") {
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  return session;
}

export async function requireMutationSession(
  request: Request,
): Promise<MutationSessionResult> {
  const session = await currentSession();
  if (!session)
    return { error: "Authentication required.", status: 401 } as const;
  const token = request.headers.get("x-csrf-token") ?? "";
  if (
    !token ||
    !safeEqual(sha256(token), session.csrfHash) ||
    !safeEqual(token, session.csrfToken)
  )
    return { error: "Request verification failed.", status: 403 } as const;
  return { session } as const;
}

export async function requireFormMutationSession(
  request: Request,
  csrf: string,
): Promise<MutationSessionResult> {
  const session = await currentSession();
  if (!session)
    return { error: "Authentication required.", status: 401 } as const;
  if (
    !csrf ||
    !safeEqual(sha256(csrf), session.csrfHash) ||
    !safeEqual(csrf, session.csrfToken)
  )
    return { error: "Request verification failed.", status: 403 } as const;
  return { session } as const;
}

export function hasRole(
  session: Awaited<ReturnType<typeof currentSession>>,
  role: "EDITOR" | "ADMIN",
) {
  return Boolean(session?.roles.has(role) || session?.roles.has("ADMIN"));
}
