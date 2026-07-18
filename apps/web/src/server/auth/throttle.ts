import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { keyedHash } from "@/server/auth/crypto";

export const THROTTLE_POLICY = {
  failureLimit: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

export function canonicalUsername(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function throttleKeys(username: string, ip: string) {
  return {
    username: keyedHash(
      environment().THROTTLE_SECRET,
      "login-username",
      canonicalUsername(username),
    ),
    ip: keyedHash(environment().THROTTLE_SECRET, "login-ip", ip),
  };
}

export async function isBlocked(
  keys: ReturnType<typeof throttleKeys>,
  now = new Date(),
) {
  const rows = await database().loginThrottle.findMany({
    where: {
      OR: [
        { keyKind: "USERNAME", keyHash: keys.username },
        { keyKind: "IP", keyHash: keys.ip },
      ],
    },
  });
  return rows.some((row) => row.blockedUntil && row.blockedUntil > now);
}

export async function recordFailure(
  keys: ReturnType<typeof throttleKeys>,
  now = new Date(),
) {
  await database().$transaction(
    async (transaction) => {
      for (const [keyKind, keyHash] of [
        ["USERNAME", keys.username],
        ["IP", keys.ip],
      ] as const) {
        const existing = await transaction.loginThrottle.findUnique({
          where: { keyKind_keyHash: { keyKind, keyHash } },
        });
        const inside = Boolean(
          existing &&
          existing.windowStartedAt.getTime() >
            now.getTime() - THROTTLE_POLICY.windowMs,
        );
        const failureCount = inside && existing ? existing.failureCount + 1 : 1;
        await transaction.loginThrottle.upsert({
          where: { keyKind_keyHash: { keyKind, keyHash } },
          create: {
            keyKind,
            keyHash,
            failureCount,
            windowStartedAt: now,
            blockedUntil:
              failureCount >= THROTTLE_POLICY.failureLimit
                ? new Date(now.getTime() + THROTTLE_POLICY.blockMs)
                : null,
          },
          update: {
            failureCount,
            windowStartedAt:
              inside && existing ? existing.windowStartedAt : now,
            blockedUntil:
              failureCount >= THROTTLE_POLICY.failureLimit
                ? new Date(now.getTime() + THROTTLE_POLICY.blockMs)
                : null,
          },
        });
      }
    },
    { isolationLevel: "Serializable" },
  );
}

export async function clearUsernameFailure(keyHash: string) {
  await database().loginThrottle.deleteMany({
    where: { keyKind: "USERNAME", keyHash },
  });
}
