import { z } from "zod";

const schema = z
  .object({
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
    PUBLICATION_BACKEND: z.enum(["git", "database"]).default("git"),
    LEADERSHIP_CANDIDATE_AUDIENCE: z
      .string()
      .url()
      .default("https://leadership.timsprototypes.com"),
    LEADERSHIP_CANDIDATE_ORIGIN: z
      .string()
      .url()
      .default("https://leadership.timsprototypes.com"),
    LEADERSHIP_CANDIDATE_EXCHANGE_SECRET: z.string().min(32).optional(),
    LEADERSHIP_ATTESTATION_SECRET: z.string().min(32).optional(),
    LEADERSHIP_ATTESTATION_KEY_ID: z
      .string()
      .min(1)
      .max(100)
      .default("leadership-hmac-v1"),
  })
  .superRefine((value, context) => {
    if (
      value.PUBLICATION_BACKEND === "database" &&
      !value.LEADERSHIP_ATTESTATION_SECRET
    )
      context.addIssue({
        code: "custom",
        path: ["LEADERSHIP_ATTESTATION_SECRET"],
        message:
          "Leadership attestation secret is required for database publication.",
      });
    if (
      value.PUBLICATION_BACKEND === "database" &&
      !value.LEADERSHIP_CANDIDATE_EXCHANGE_SECRET
    )
      context.addIssue({
        code: "custom",
        path: ["LEADERSHIP_CANDIDATE_EXCHANGE_SECRET"],
        message:
          "Leadership candidate exchange secret is required for database publication.",
      });
  });

let cached: z.infer<typeof schema> | undefined;

export function environment() {
  cached ??= schema.parse(process.env);
  return cached;
}

export function isSecureOrigin() {
  return new URL(environment().SITUATION_STUDIO_ORIGIN).protocol === "https:";
}
