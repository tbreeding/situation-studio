import { z } from "zod";

export const skillSchema = z.enum([
  "one-on-ones",
  "feedback",
  "coaching",
  "delegation",
  "team-dynamics",
  "transition-to-manager",
]);

const repositoryIdentitySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/u);
const reviewedDateSchema = z.coerce.date();

export const situationFrontmatterSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().min(20),
  description: z.string().min(50).max(180),
  stakes: z.string().min(30),
  primarySkill: skillSchema,
  tags: z.array(z.string()).min(2),
  audience: z.array(z.enum(["manager", "technical-lead"])).min(1),
  preparationTime: z.enum(["5 minutes", "15 minutes", "30 minutes"]),
  emotionalLoad: z.enum(["low", "medium", "high"]),
  pattern: z.enum(["first-occurrence", "emerging-pattern", "repeated-pattern"]),
  scope: z.enum(["individual", "pair", "team"]),
  support: z
    .array(z.enum(["hr", "legal", "safety", "security", "senior-leader"]))
    .default([]),
  published: z.coerce.date(),
  lastReviewed: reviewedDateSchema,
  author: repositoryIdentitySchema,
  reviewer: repositoryIdentitySchema,
  sourceReferences: z.array(z.string().min(1)).min(1),
  relatedSituationIds: z.array(z.string().min(1)).min(2),
  practiceId: z.enum(["listen-first", "coaching-choice", "feedback-fork"]),
  practiceVariant: z.string().min(2),
  fieldNotePresent: z.literal(true),
  safetyEscalationNotePresent: z.literal(true),
  socialHook: z.string().min(20),
  campaignCluster: z.string().regex(/^[a-z0-9_]+$/u),
  reviewStatus: z.literal("human-approved"),
});

export const guideFrontmatterSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().min(15),
  description: z.string().min(50).max(180),
  eyebrow: z.string().min(3),
  relatedSituationIds: z.array(z.string().min(1)).min(3),
  practiceId: z.enum(["listen-first", "coaching-choice", "feedback-fork"]),
  published: z.coerce.date(),
  lastReviewed: reviewedDateSchema,
  author: repositoryIdentitySchema,
  reviewer: repositoryIdentitySchema,
  reviewStatus: z.literal("human-approved"),
});

export const bibliographyEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z
    .string()
    .refine(
      (value) => value.startsWith("/") || URL.canParse(value),
      "Expected a site-relative path or absolute URL",
    ),
  publisher: z.string().min(1),
  note: z.string().min(1),
});

export const authorSchema = z.object({
  id: repositoryIdentitySchema,
  name: z.string().min(1),
  role: z.string().min(1),
  bio: z.string().min(1),
});

export const practiceChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  consequenceId: z.string().min(1),
  consequence: z.string().min(1),
  explanation: z.string().min(1),
  signal: z.enum(["toward", "pause", "away"]),
});

export const practiceRoundSchema = z.object({
  id: z.string().min(1),
  setup: z.string().min(1),
  prompt: z.string().min(1),
  choices: z.array(practiceChoiceSchema).min(2).max(4),
});

export const practiceSchema = z.object({
  id: z.enum(["listen-first", "coaching-choice", "feedback-fork"]),
  title: z.string().min(1),
  description: z.string().min(1),
  estimatedTime: z.string().min(1),
  rounds: z.array(practiceRoundSchema).min(2),
});

export const toolFieldSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  label: z.string().min(1),
  prompt: z.string().min(1),
  placeholder: z.string(),
  rows: z.number().int().min(1).max(12).optional(),
  type: z.enum(["text", "date"]).optional(),
});

export const toolConfigSchema = z.object({
  id: z.enum(["conversation-prep", "delegation-brief", "one-on-one-agenda"]),
  title: z.string().min(1),
  description: z.string().min(50),
  time: z.string().min(1),
  fields: z.array(toolFieldSchema).min(1),
});

export const toolCatalogSchema = z.array(toolConfigSchema).length(3);

export type SituationFrontmatter = z.infer<typeof situationFrontmatterSchema>;
export type GuideFrontmatter = z.infer<typeof guideFrontmatterSchema>;
export type Practice = z.infer<typeof practiceSchema>;
export type ToolField = z.infer<typeof toolFieldSchema>;
export type ToolConfig = z.infer<typeof toolConfigSchema>;
