import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function keyedHash(
  secret: string,
  purpose: string,
  value: string,
): string {
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`)
    .digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
