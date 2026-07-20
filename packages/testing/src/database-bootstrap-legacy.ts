export type ArtifactRegistryIdentity = {
  logicalId: string;
  canonicalPath: string;
  type: string;
};

export const bootstrapLegacyAliases = [
  {
    legacyLogicalId: "lesson_plan:000-syllabus",
    canonicalLogicalId: "lesson-plan:workshop-syllabus",
    canonicalPath: "sourceMaterial/leadership-workshops-master/000_Syllabus.md",
    type: "LESSON_PLAN",
  },
  {
    legacyLogicalId:
      "lesson_plan:001-manager-tools-three-pillars-of-leadership",
    canonicalLogicalId:
      "lesson-plan:001-manager-tools-three-pillars-of-leadership",
    canonicalPath:
      "sourceMaterial/leadership-workshops-master/lesson-plans/001 Manager Tools - Three Pillars of Leadership.md",
    type: "LESSON_PLAN",
  },
  {
    legacyLogicalId: "lesson_plan:002-manager-tools-power-triangle-and-trinity",
    canonicalLogicalId:
      "lesson-plan:002-manager-tools-power-triangle-and-trinity",
    canonicalPath:
      "sourceMaterial/leadership-workshops-master/lesson-plans/002 Manager Tools - Power Triangle and Trinity.md",
    type: "LESSON_PLAN",
  },
  {
    legacyLogicalId: "lesson_plan:003-manager-tools-the-trinity-and-1on1s",
    canonicalLogicalId: "lesson-plan:003-manager-tools-the-trinity-and-1on1s",
    canonicalPath:
      "sourceMaterial/leadership-workshops-master/lesson-plans/003 Manager Tools - The Trinity and 1on1s.md",
    type: "LESSON_PLAN",
  },
  {
    legacyLogicalId: "preparation_prompt:prompt-lesson-plan-generator",
    canonicalLogicalId: "preparation-prompt:prompt-lesson-plan-generator",
    canonicalPath:
      "sourceMaterial/leadership-workshops-master/misc/prompt-lesson-plan-generator.md",
    type: "PREPARATION_PROMPT",
  },
] as const;

export const bootstrapLegacyRetirements = [
  {
    logicalId: "source:course-syllabus",
    canonicalPath: "content/bibliography/sources.json#source:course-syllabus",
    type: "SOURCE",
  },
  {
    logicalId: "source:edmondson-psychological-safety",
    canonicalPath:
      "content/bibliography/sources.json#source:edmondson-psychological-safety",
    type: "SOURCE",
  },
  {
    logicalId: "source:one-on-one-lesson",
    canonicalPath: "content/bibliography/sources.json#source:one-on-one-lesson",
    type: "SOURCE",
  },
  {
    logicalId: "validator:content-graph",
    canonicalPath: "lib/content.ts#validator:content-graph",
    type: "VALIDATOR",
  },
  {
    logicalId: "route:guides",
    canonicalPath: "virtual/route/route-guides#route:guides",
    type: "ROUTE",
  },
  {
    logicalId: "route:home",
    canonicalPath: "virtual/route/route-home#route:home",
    type: "ROUTE",
  },
  {
    logicalId: "route:practice",
    canonicalPath: "virtual/route/route-practice#route:practice",
    type: "ROUTE",
  },
  {
    logicalId: "route:situations",
    canonicalPath: "virtual/route/route-situations#route:situations",
    type: "ROUTE",
  },
] as const;

export const bootstrapLegacyPathMoves = [
  {
    logicalId: "tool:catalog",
    legacyPath: "lib/tools.ts",
    canonicalPath: "content/tools/tools.json",
    type: "TOOL",
  },
] as const;

export function matchesBootstrapLegacyAlias(
  canonical: ArtifactRegistryIdentity,
  existing: ArtifactRegistryIdentity,
): boolean {
  return bootstrapLegacyAliases.some(
    (alias) =>
      alias.canonicalLogicalId === canonical.logicalId &&
      alias.canonicalPath === canonical.canonicalPath &&
      alias.type === canonical.type &&
      alias.legacyLogicalId === existing.logicalId &&
      alias.canonicalPath === existing.canonicalPath &&
      alias.type === existing.type,
  );
}

export function matchesBootstrapLegacyRetirement(
  existing: ArtifactRegistryIdentity,
): boolean {
  return bootstrapLegacyRetirements.some(
    (retirement) =>
      retirement.logicalId === existing.logicalId &&
      retirement.canonicalPath === existing.canonicalPath &&
      retirement.type === existing.type,
  );
}

export function matchesBootstrapLegacyPathMove(
  canonical: ArtifactRegistryIdentity,
  existing: ArtifactRegistryIdentity,
): boolean {
  return bootstrapLegacyPathMoves.some(
    (move) =>
      move.logicalId === canonical.logicalId &&
      move.canonicalPath === canonical.canonicalPath &&
      move.type === canonical.type &&
      move.logicalId === existing.logicalId &&
      move.legacyPath === existing.canonicalPath &&
      move.type === existing.type,
  );
}
