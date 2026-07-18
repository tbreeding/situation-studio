import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  SITUATION_STUDIO_ORIGIN: z.string().url(),
  SITUATION_STUDIO_HOST: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  THROTTLE_SECRET: z.string().min(32),
  LEADERSHIP_REPO_PATH: z
    .string()
    .min(1)
    .default("/home/admin/projects/leadership/current"),
  PROVIDER_EXECUTION_MODE: z
    .enum(["disabled", "fake", "api"])
    .default("disabled"),
});

let cached: z.infer<typeof schema> | undefined;

export function environment() {
  cached ??= schema.parse(process.env);
  return cached;
}

export function isSecureOrigin() {
  return new URL(environment().SITUATION_STUDIO_ORIGIN).protocol === "https:";
}
