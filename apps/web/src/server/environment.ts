import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    STUDIO_DATABASE_URL: z.url(),
    SESSION_SECRET: z.string().min(32),
    CSRF_SECRET: z.string().min(32),
    THROTTLE_SECRET: z.string().min(32),
    SITUATION_STUDIO_ORIGIN: z.url(),
    LEADERSHIP_STUDIO_READER_DATABASE_URL: z.url().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === "production" &&
      !value.SITUATION_STUDIO_ORIGIN.startsWith("https://")
    )
      context.addIssue({
        code: "custom",
        path: ["SITUATION_STUDIO_ORIGIN"],
        message: "Production requires an HTTPS Situation Studio origin.",
      });
    if (
      value.NODE_ENV === "production" &&
      !value.LEADERSHIP_STUDIO_READER_DATABASE_URL
    )
      context.addIssue({
        code: "custom",
        path: ["LEADERSHIP_STUDIO_READER_DATABASE_URL"],
        message: "Production requires the Leadership read-only connection.",
      });
  });

let cached: z.infer<typeof schema> | undefined;

export function environment() {
  cached ??= schema.parse(process.env);
  return cached;
}

export function isSecureOrigin(): boolean {
  return environment().SITUATION_STUDIO_ORIGIN.startsWith("https://");
}
