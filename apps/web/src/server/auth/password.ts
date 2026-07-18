import argon2 from "argon2";

const options: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};

export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$rHSP/Ba76Uh6btTZj4K0XA$jmMDYvewV6r29ztsuDAaehClMViv1lvkAUOkwtj7lAo";

export function validatePassword(password: string): void {
  const length = [...password].length;
  if (length < 12 || length > 1_024)
    throw new Error("Password must contain 12–1024 Unicode characters.");
}

export function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return argon2.hash(password, options);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  const bounded = [...password].slice(0, 1_024).join("");
  try {
    return await argon2.verify(hash, bounded);
  } catch {
    return false;
  }
}
