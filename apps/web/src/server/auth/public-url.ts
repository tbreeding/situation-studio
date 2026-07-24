import { environment } from "@/server/environment";

export function publicUrl(
  path: string,
  origin = environment().SITUATION_STUDIO_ORIGIN,
): URL {
  return new URL(path, origin);
}
