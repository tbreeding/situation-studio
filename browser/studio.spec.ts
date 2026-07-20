import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  canonicalBundleHash,
  type BundleManifest,
} from "@situation-studio/domain";

const password = "Studio-Test-Only-Password-2026!";

async function login(page: Page, username = "studio-admin") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Enter Situation Studio" }).click();
  await expect(page).toHaveURL("/");
}

function skipUnlessDesktop(testInfo: TestInfo) {
  test.skip(testInfo.project.name === "mobile-chromium", "Desktop UX pass");
}

async function expectContained(page: Page) {
  const layout = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".appHeader");
    const bounds = header?.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      headerLeft: bounds?.left ?? 0,
      headerRight: bounds?.right ?? 0,
      headerScrollWidth: header?.scrollWidth ?? 0,
      headerClientWidth: header?.clientWidth ?? 0,
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.headerLeft).toBeGreaterThanOrEqual(-1);
  expect(layout.headerRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.headerScrollWidth).toBeLessThanOrEqual(
    layout.headerClientWidth + 1,
  );
}

async function expectMinimumFontSize(locator: Locator, minimum = 14) {
  const sizes = await locator.evaluateAll((elements) =>
    elements.map((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    ),
  );
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(minimum);
}

test("authenticated inventory exposes all imported situations and core navigation", async ({
  page,
}) => {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "One rule. Every learning surface." }),
  ).toBeVisible();
  await expect(page.locator(".situationCard")).toHaveCount(15);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByText("Sensitive-data boundary:")).toBeVisible();
});

test("unauthenticated protected routes return to Studio login", async ({
  page,
}) => {
  await page.goto("/administration");
  await expect(page).toHaveURL(/\/login\?expired=1$/u);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("private-host root probe exposes readiness only", async ({ request }) => {
  const response = await request.get("/", {
    headers: { host: "192.168.1.120:3015" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "origin-ready" });
});

test("administration stays contained before and after creating an invitation", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.goto("/administration");

  const assertContained = async () => {
    const layout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      panels: Array.from(
        document.querySelectorAll<HTMLElement>(".administrationGrid > *"),
      ).map((panel) => {
        const bounds = panel.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      }),
      userPanelWidth:
        document
          .querySelector<HTMLElement>(".administrationGrid > .panel")
          ?.getBoundingClientRect().width ?? 0,
      userContentWidth:
        document
          .querySelector<HTMLElement>(".administrationGrid > .panel form")
          ?.getBoundingClientRect().width ?? 0,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    for (const panel of layout.panels) {
      expect(panel.left).toBeGreaterThanOrEqual(-1);
      expect(panel.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    }
    expect(layout.userContentWidth).toBeGreaterThan(
      layout.userPanelWidth * 0.7,
    );
  };

  await assertContained();
  const suffix = testInfo.project.name;
  await page
    .getByLabel("Username", { exact: true })
    .fill(`layout-${suffix}-${Date.now()}`);
  await page.getByLabel("Display name").fill(`Layout ${suffix}`);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByText("Single-use activation link")).toBeVisible();
  await assertContained();
  const activationWidth = await page
    .locator(".activationUrl")
    .evaluate((element) => ({
      link: element.getBoundingClientRect().width,
      panel:
        element.closest<HTMLElement>(".panel")?.getBoundingClientRect().width ??
        0,
    }));
  expect(activationWidth.link).toBeGreaterThan(activationWidth.panel * 0.7);
  await expect(page.locator(".activationUrl")).toHaveCSS(
    "overflow-wrap",
    "anywhere",
  );
});

test("desktop navigation reflects route and server-authoritative permissions", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  await login(page, "studio-editor");
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(
    primary.getByRole("link", { name: "Situations" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    primary.getByRole("link", { name: "Administration" }),
  ).toHaveCount(0);
  await expectContained(page);

  await primary.getByRole("link", { name: "Jobs" }).click();
  await expect(primary.getByRole("link", { name: "Jobs" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto("/administration");
  await expect(page).toHaveURL("/");
  await expect(
    primary.getByRole("link", { name: "Administration" }),
  ).toHaveCount(0);
});

test("inventory searches metadata, combines filters, sorts, and recovers from zero results", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  await login(page);
  const cards = page.locator(".situationCard");
  await expect(cards).toHaveCount(15);

  const search = page.getByRole("searchbox", { name: "Find a situation" });
  await search.fill("tears during");
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole("heading")).toContainText(
    "An employee cries during a difficult conversation",
  );
  await search.fill("one-on-ones-became-status-updates");
  await expect(cards).toHaveCount(1);
  await search.fill("feedback");
  await expect(cards).toHaveCount(4);

  await search.fill("");
  await page.getByRole("checkbox", { name: "Needs attention" }).check();
  await expect(
    page.getByRole("heading", { name: "No situations match" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset all filters" }).click();
  await page.getByLabel("Lifecycle").selectOption("ACTIVE");
  await page.getByLabel("Publication").selectOption("PUBLISHED");
  await page.getByLabel("Checkout availability").selectOption("AVAILABLE");
  await expect(cards).toHaveCount(15);

  const titles = await cards.getByRole("heading").allTextContents();
  expect(titles).toEqual(
    [...titles].sort((left, right) => left.localeCompare(right)),
  );
  await expectContained(page);
});

test("creation brief groups all controls and blocks invalid or duplicate input before mutation", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  await login(page, "studio-editor");
  await page.goto("/situations/new");
  const createRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/situations")
    )
      createRequests.push(request.url());
  });

  await expect(page.locator("[required]")).toHaveCount(19);
  await expectMinimumFontSize(
    page.locator(
      ".fieldHelp, .briefSection > summary small, .briefSubmit p, .errorSummary p, .errorSummary li",
    ),
  );
  for (const section of [
    "Name and connect",
    "Understand the situation",
    "Set safety and learning guardrails",
    "Define the guidance",
  ])
    await expect(
      page.getByText(section, { exact: true }).first(),
    ).toBeVisible();

  await page
    .getByRole("button", { name: "Confirm brief and create draft" })
    .click();
  await expect(
    page.getByRole("heading", { name: "The brief is not ready" }),
  ).toBeVisible();
  await expect(page.getByLabel("Situation title")).toBeFocused();
  expect(createRequests).toHaveLength(0);

  const title = "A manager needs a reliable coaching conversation";
  await page.getByLabel("Situation title").fill(title);
  await expect(page.getByLabel("Stable slug")).toHaveValue(
    "a-manager-needs-a-reliable-coaching-conversation",
  );
  await page.getByLabel("Stable slug").fill("Invalid Slug!");
  await page
    .getByRole("button", { name: "Confirm brief and create draft" })
    .click();
  await expect(page.locator("#slug-error")).toContainText(
    "lowercase letters, numbers, and single hyphens",
  );
  expect(createRequests).toHaveLength(0);

  await page.getByLabel("Stable slug").fill("defensive-about-feedback");
  await page
    .getByRole("button", { name: "Confirm brief and create draft" })
    .click();
  await expect(page.getByLabel("Stable slug")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#slug-error")).toContainText(
    "already belongs to another situation",
  );
  await expect(page.getByLabel("Situation title")).toHaveValue(title);
  expect(createRequests).toHaveLength(0);

  await page.getByRole("button", { name: "Regenerate from title" }).click();
  await page.getByLabel("First related situation").selectOption({ index: 1 });
  await page.getByLabel("Second related situation").selectOption({ index: 2 });
  const fieldValues: Record<string, string> = {
    "Observed problem":
      "Three agreed handoffs arrived after the date without an earlier risk signal from the employee.",
    Audience: "Managers of individual contributors",
    "Manager role":
      "Sets priorities, coaches work, and gives observable feedback.",
    "Known context":
      "The expectations and dates were documented before the work began.",
    "Accepted assumptions":
      "The manager has checked for conflicting priorities.",
    Unknowns: "Whether a late approval dependency changed the delivery date.",
    "Impact of unknowns":
      "A blocked dependency would shift the advice toward repairing the planning system.",
    "Desired outcome":
      "The employee raises delivery risk before the agreed checkpoint and proposes a tradeoff.",
    "Safety and escalation":
      "Seek qualified support for protected concerns or formal discipline.",
    "Observable learning objective":
      "The manager can identify the pattern and state one observable next move.",
    "Source basis": "Leadership course syllabus and feedback module.",
    "What this should advise":
      "Name the pattern, ask one question, and agree on a next behavior.",
    "What this must not advise":
      "Do not diagnose intent or bypass required support.",
    "Expected learning surfaces":
      "Situation, practice, workshop lesson, and preparation prompt.",
  };
  for (const [label, value] of Object.entries(fieldValues))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page
    .getByRole("checkbox", { name: /Final human confirmation/u })
    .check();
  await expect(page.getByText("4 of 4", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The brief is not ready" }),
  ).toHaveCount(0);
  expect(createRequests).toHaveLength(0);
  await expectContained(page);
});

test("published workspaces default to rendered guidance and preserve exact read-only source", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      consoleProblems.push(message.text());
  });
  await login(page, "studio-editor");
  const workspaceHrefs = await page
    .locator(".situationCard")
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("href") ?? ""),
    );
  expect(workspaceHrefs).toHaveLength(15);

  for (const href of workspaceHrefs) {
    await page.goto(href);
    await expect(
      page.getByRole("tab", { name: "Rendered guidance" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: "The short answer" }),
    ).toBeVisible();
    const titleLayout = await page
      .locator(".workspaceTop h1")
      .evaluate((heading) => {
        const style = getComputedStyle(heading);
        return {
          lines:
            heading.getBoundingClientRect().height /
            Number.parseFloat(style.lineHeight),
          clipped: heading.scrollHeight > heading.clientHeight + 6,
        };
      });
    expect(titleLayout.lines).toBeLessThanOrEqual(2.1);
    expect(titleLayout.clipped).toBe(false);
    await page.getByRole("tab", { name: "Source MDX" }).click();
    const source = page.getByLabel("Situation MDX");
    await expect(source).toHaveAttribute("readonly", "");
    await expect(source).toHaveCSS("font-size", "14px");
    await expect(source).not.toHaveValue("");
    await expectContained(page);
  }

  await expectMinimumFontSize(
    page.locator(
      ".workspaceSummary strong, .workspaceSummary small, .artifactStateNotice, .lifecycleExplanation, .lifecycleList strong, .lifecycleList small, .dangerArea p:not(.eyebrow)",
    ),
  );

  await page.goto("/situations/repeatedly-misses-deadlines");
  await page.getByRole("tab", { name: "Source MDX" }).click();
  const source = page.getByLabel("Situation MDX");
  const exactSource = await source.inputValue();
  await page.getByRole("button", { name: "Expand source" }).click();
  await expect(page.locator(".sourcePanel")).toHaveClass(/expanded/u);
  await expect(
    page.getByRole("button", { name: "Close expanded source" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(source).toBeFocused();
  await expect(source).toHaveValue(exactSource);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Expand source" }),
  ).toBeFocused();
  await page
    .locator(".dependencyPanel")
    .getByText("Connected bundle surfaces")
    .click();
  const dependency = page
    .locator(".dependencyPanel a[href^='/situations/']")
    .first();
  await expect(dependency).toBeVisible();
  const dependencyHref = await dependency.getAttribute("href");
  await dependency.click();
  await expect(page).toHaveURL(new RegExp(`${dependencyHref}$`, "u"));
  expect(consoleProblems).toEqual([]);
});

test("archive danger area requires a reason and confirmation without mutating baseline", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  await login(page);
  await page.goto("/situations/repeatedly-misses-deadlines");
  const archive = page.getByRole("button", { name: "Archive situation" });
  await expect(archive).toBeDisabled();
  const reason = page.getByLabel("Required reason");
  await reason.focus();
  await reason.blur();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await reason.fill("Desktop UX confirmation check only");
  await expect(archive).toBeEnabled();
  let lifecycleRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/lifecycle"))
      lifecycleRequests += 1;
  });
  page.once("dialog", async (dialog) => dialog.dismiss());
  await archive.click();
  await expect(page.getByText("Lifecycle change cancelled")).toBeVisible();
  expect(lifecycleRequests).toBe(0);
});

test("Jobs and Capacity empty states explain the next valid action", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  await login(page, "studio-editor");
  await page.goto("/jobs");
  await expect(
    page.getByRole("heading", { name: "No review jobs yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Find an eligible situation" }),
  ).toBeVisible();
  await expectContained(page);
  await page.goto("/capacity");
  await expect(
    page.getByRole("heading", { name: "AI review providers are disabled" }),
  ).toBeVisible();
  await expect(
    page.locator(".emptyState").getByText("Manual editing remains available"),
  ).toBeVisible();
  await expect(page.getByText("Technical details")).toBeVisible();
  await expectContained(page);
  if (page.viewportSize()?.height === 900) {
    const layout = await page.evaluate(() => ({
      height: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
  }
});

test("affected desktop pages have no critical or serious accessibility violations", async ({
  page,
}, testInfo) => {
  skipUnlessDesktop(testInfo);
  await login(page, "studio-editor");
  for (const route of [
    "/",
    "/situations/new",
    "/situations/repeatedly-misses-deadlines",
    "/jobs",
    "/capacity",
  ]) {
    await page.goto(route);
    const results = await new AxeBuilder({ page }).analyze();
    const severe = results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    );
    expect(
      severe,
      `${route}: ${severe.map((item) => item.id).join(", ")}`,
    ).toEqual([]);
  }
});

test("a synthetic proposal remains unmistakably separate from the published baseline", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  skipUnlessDesktop(testInfo);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(
    !databaseUrl || !/(?:test|ux|playwright)/iu.test(databaseUrl),
    "Candidate workflow mutation requires a clearly disposable database",
  );
  if (!databaseUrl) return;

  const slug =
    testInfo.project.name === "desktop-1280"
      ? "defensive-about-feedback"
      : "delegated-work-wrong-result";
  const sentinel = `Candidate-only sentinel ${testInfo.project.name}`;
  const bundleSentinel = `Immutable bundle-only sentinel ${testInfo.project.name}`;
  const database = new Client({ connectionString: databaseUrl });
  let draftId: string | null = null;
  let bundleId: string | null = null;
  let situationId: string | null = null;

  await database.connect();
  try {
    const situationRecord = await database.query<{ id: string }>(
      "SELECT id FROM situations WHERE slug = $1",
      [slug],
    );
    situationId = situationRecord.rows[0]?.id ?? null;
    expect(situationId).not.toBeNull();
    if (!situationId) return;
    await login(page, "studio-editor");
    await page.goto(`/situations/${slug}`);
    await Promise.all([
      page.waitForEvent("framenavigated"),
      page.getByRole("button", { name: "Check out for editing" }).click(),
    ]);
    await expect(
      page.getByText(/Draft revision \d+ · ready to edit/u),
    ).toBeVisible();

    const draftRecord = await database.query<{
      id: string;
      base_snapshot_id: string;
      commit_sha: string;
      manifest_hash: string;
      current_revision: number;
    }>(
      `SELECT d.id, d.base_snapshot_id, d.current_revision,
              rs.commit_sha, rs.manifest_hash
       FROM drafts d
       JOIN repository_snapshots rs ON rs.id = d.base_snapshot_id
       WHERE d.situation_id = $1 AND d.active = true
       ORDER BY d.created_at DESC
       LIMIT 1`,
      [situationId],
    );
    const draft = draftRecord.rows[0];
    expect(draft).toBeDefined();
    if (!draft) return;
    draftId = draft.id;

    await page.getByRole("tab", { name: "Source MDX" }).click();
    const source = page.getByLabel("Situation MDX");
    await expect(source).not.toHaveAttribute("readonly", "");
    await source.fill(
      `${await source.inputValue()}\n\n## ${sentinel}\n\nThis candidate text is not published.`,
    );
    const candidateBody = await source.inputValue();
    const candidateHash = createHash("sha256")
      .update(candidateBody)
      .digest("hex");
    const sourceArtifact = await database.query<{
      revision_id: string;
      artifact_id: string;
      actor_id: string;
      logical_id: string;
      path: string;
      type: BundleManifest["artifacts"][number]["type"];
      base_hash: string;
    }>(
      `SELECT revision.id AS revision_id, artifact.id AS artifact_id,
              editor.id AS actor_id, artifact.logical_id,
              draft_artifact.path, draft_artifact.type,
              draft_artifact.content_hash AS base_hash
       FROM draft_revisions AS revision
       JOIN draft_artifacts AS draft_artifact
         ON draft_artifact.revision_id = revision.id
       JOIN artifacts AS artifact ON artifact.id = draft_artifact.artifact_id
       JOIN users AS editor ON editor.username = 'studio-editor'
       WHERE revision.draft_id = $1
         AND revision.revision = $2
         AND artifact.logical_id = $3`,
      [draft.id, draft.current_revision, `situation:${slug}`],
    );
    const fixtureSource = sourceArtifact.rows[0];
    expect(fixtureSource).toBeDefined();
    if (!fixtureSource) return;
    const fixtureRevisionId = randomUUID();
    await database.query("BEGIN");
    try {
      await database.query(
        `INSERT INTO content_blobs (hash, body, byte_length)
         VALUES ($1, $2, $3)
         ON CONFLICT (hash) DO NOTHING`,
        [candidateHash, candidateBody, Buffer.byteLength(candidateBody)],
      );
      await database.query(
        `INSERT INTO draft_revisions
         (id, draft_id, revision, parent_revision_id, manifest_hash, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fixtureRevisionId,
          draft.id,
          draft.current_revision + 1,
          fixtureSource.revision_id,
          createHash("sha256")
            .update(`desktop-ux-fixture:${candidateHash}`)
            .digest("hex"),
          fixtureSource.actor_id,
        ],
      );
      await database.query(
        `INSERT INTO draft_artifacts
         (revision_id, artifact_id, path, type, content_hash, change_kind)
         SELECT $1, artifact_id, path, type,
                CASE WHEN artifact_id = $2 THEN $3 ELSE content_hash END,
                CASE WHEN artifact_id = $2 THEN 'MODIFY'::"ChangeKind" ELSE change_kind END
         FROM draft_artifacts
         WHERE revision_id = $4`,
        [
          fixtureRevisionId,
          fixtureSource.artifact_id,
          candidateHash,
          fixtureSource.revision_id,
        ],
      );
      await database.query(
        `UPDATE drafts
         SET current_revision = $1, state = 'DRAFTING'
         WHERE id = $2`,
        [draft.current_revision + 1, draft.id],
      );
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }

    const latestBundle = await database.query<{ revision: number }>(
      "SELECT COALESCE(MAX(revision), 0)::integer AS revision FROM proposed_bundles WHERE situation_id = $1",
      [situationId],
    );
    const fixtureHash = (label: string) =>
      createHash("sha256")
        .update(`${label}:${testInfo.project.name}:${Date.now()}`)
        .digest("hex");
    const bundleBody = candidateBody
      .replace(sentinel, bundleSentinel)
      .replace("preparationTime: 15 minutes", "preparationTime: 20 minutes");
    const bundleCandidateHash = createHash("sha256")
      .update(bundleBody)
      .digest("hex");
    const bundleRevision = (latestBundle.rows[0]?.revision ?? 0) + 1;
    const graphHash = fixtureHash("graph");
    const bundleManifest: BundleManifest = {
      schemaVersion: "1",
      situationId,
      revision: bundleRevision,
      baseCommit: draft.commit_sha,
      baseManifestHash: draft.manifest_hash,
      briefHash: null,
      graphHash,
      artifacts: [
        {
          logicalId: fixtureSource.logical_id,
          type: fixtureSource.type,
          path: fixtureSource.path,
          baseHash: fixtureSource.base_hash,
          candidateHash: bundleCandidateHash,
          changeKind: "MODIFY",
          noChangeRationale: null,
        },
      ],
      relationshipChanges: [],
    };
    const canonicalHash = canonicalBundleHash(bundleManifest);
    bundleId = randomUUID();
    await database.query("BEGIN");
    try {
      await database.query(
        `INSERT INTO content_blobs (hash, body, byte_length)
         VALUES ($1, $2, $3)
         ON CONFLICT (hash) DO NOTHING`,
        [bundleCandidateHash, bundleBody, Buffer.byteLength(bundleBody)],
      );
      await database.query(
        `INSERT INTO proposed_bundles
         (id, situation_id, revision, snapshot_id, draft_id, base_commit,
          base_manifest_hash, graph_hash, canonical_hash, manifest, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'HUMAN_REVIEW')`,
        [
          bundleId,
          situationId,
          bundleRevision,
          draft.base_snapshot_id,
          draft.id,
          draft.commit_sha,
          draft.manifest_hash,
          graphHash,
          canonicalHash,
          JSON.stringify(bundleManifest),
        ],
      );
      await database.query(
        `INSERT INTO bundle_artifacts
         (bundle_id, artifact_id, path, type, base_hash, candidate_hash,
          content_hash, change_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'MODIFY')`,
        [
          bundleId,
          fixtureSource.artifact_id,
          fixtureSource.path,
          fixtureSource.type,
          fixtureSource.base_hash,
          bundleCandidateHash,
        ],
      );
      const environmentHash = fixtureHash("validation-environment");
      for (const validator of [
        "required-role-completion",
        "candidate-safety",
        "contradiction-audit",
      ])
        await database.query(
          `INSERT INTO validation_runs
           (id, bundle_id, bundle_hash, validator, version, environment_hash,
            state, summary, started_at, finished_at)
           VALUES ($1, $2, $3, $4, '1', $5, 'PASSED',
                   'Synthetic exact-byte fixture passed.', NOW(), NOW())`,
          [randomUUID(), bundleId, canonicalHash, validator, environmentHash],
        );
      await database.query(
        `INSERT INTO comments
         (id, bundle_id, author_id, body, blocking)
         VALUES ($1, $2, $3, $4, true)`,
        [
          randomUUID(),
          bundleId,
          fixtureSource.actor_id,
          "Inspect the immutable candidate before approval.",
        ],
      );
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
    await page.reload();
    await expect(
      page.getByRole("heading", { name: bundleSentinel }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: sentinel })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Proposal candidate" }),
    ).toBeVisible();
    await expect(page.locator(".artifactStateNotice.candidate")).toContainText(
      "not published",
    );
    const comparison = page.locator(".diffPanel");
    await comparison.getByText("Compare published and proposal bytes").click();
    await expect(comparison.locator(".diffLine.removed").first()).toBeVisible();
    await expect(comparison.locator(".diffLine.added").first()).toBeVisible();
    await expect(comparison.getByText("Scroll linked ↕")).toBeVisible();
    const publishedDiff = comparison.locator(".diffScroller").nth(0);
    const candidateDiff = comparison.locator(".diffScroller").nth(1);
    await publishedDiff.evaluate((element) => {
      element.scrollTop = 240;
      element.scrollLeft = 80;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() =>
        candidateDiff.evaluate((element) => ({
          left: element.scrollLeft,
          top: element.scrollTop,
        })),
      )
      .toEqual({ left: 80, top: 240 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await candidateDiff.evaluate((element) => {
      element.scrollTop = 120;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => publishedDiff.evaluate((element) => element.scrollTop))
      .toBe(120);

    const reviewSpacing = await page
      .locator(".exactBundlePanel")
      .evaluate((panel) => {
        const summary = panel.querySelector(":scope > summary");
        const title = summary?.querySelector(".exactBundleSummaryCopy strong");
        const description = summary?.querySelector(
          ".exactBundleSummaryCopy small",
        );
        const summaryBounds = summary?.getBoundingClientRect();
        const titleBounds = title?.getBoundingClientRect();
        const descriptionBounds = description?.getBoundingClientRect();
        return {
          summaryDisplay: summary ? getComputedStyle(summary).display : null,
          summaryHeight: summaryBounds?.height ?? 0,
          titleDescriptionGap:
            titleBounds && descriptionBounds
              ? descriptionBounds.top - titleBounds.bottom
              : 0,
        };
      });
    expect(reviewSpacing.summaryDisplay).toBe("grid");
    expect(reviewSpacing.summaryHeight).toBeGreaterThanOrEqual(70);
    expect(reviewSpacing.titleDescriptionGap).toBeGreaterThanOrEqual(5);

    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page);
    await page.goto(`/situations/${slug}`);
    await expect(
      page.getByRole("heading", { name: bundleSentinel }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Proposal candidate revision \d+ · read-only · not published/u,
      ),
    ).toBeVisible();
    const confirmationActionGap = await page
      .locator(".commentComposer")
      .evaluate((composer) => {
        const confirmation = composer.querySelector(".confirmation");
        const actions = composer.querySelector(".commentActions");
        const confirmationBounds = confirmation?.getBoundingClientRect();
        const actionsBounds = actions?.getBoundingClientRect();
        return confirmationBounds && actionsBounds
          ? actionsBounds.top - confirmationBounds.bottom
          : 0;
      });
    expect(confirmationActionGap).toBeGreaterThanOrEqual(12);
    await expect(page.locator(".workspaceSummary")).toContainText(
      "Official baseline",
    );
    const sessionCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "situation_studio_dev",
    );
    expect(sessionCookie).toBeDefined();
    if (!sessionCookie) return;
    const sessionTokenHash = createHash("sha256")
      .update(sessionCookie.value)
      .digest("hex");
    const agedSession = await database.query(
      `UPDATE sessions
       SET reauthenticated_at = NOW() - INTERVAL '1 hour'
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id`,
      [sessionTokenHash],
    );
    expect(agedSession.rows).toHaveLength(1);

    const [blockedPrepareResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/api/bundles/${bundleId}/prepare-approval`),
      ),
      page
        .getByRole("button", {
          name: "Prepare exact bundle for my approval",
        })
        .click(),
    ]);
    expect(blockedPrepareResponse.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Confirm your password" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(
      "prepare this exact bundle for approval",
    );
    const bundleBeforeReauthentication = await database.query(
      "SELECT id FROM proposed_bundles WHERE parent_bundle_id = $1",
      [bundleId],
    );
    expect(bundleBeforeReauthentication.rows).toHaveLength(0);

    await page.getByLabel("Password", { exact: true }).fill(password);
    const [reauthenticationResponse, prepareResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/auth/reauthenticate"),
      ),
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/api/bundles/${bundleId}/prepare-approval`),
      ),
      page.getByRole("button", { name: "Confirm and continue" }).click(),
    ]);
    expect(reauthenticationResponse.status()).toBe(200);
    expect(prepareResponse.status()).toBe(201);
    await expect(
      page.getByText(/Reviewer studio-admin-reviewer · review date/u),
    ).toBeVisible();
    const sourceTab = page.getByRole("tab", { name: "Source MDX" });
    await sourceTab.click();
    await expect(sourceTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Situation MDX")).toHaveValue(
      /reviewer: studio-admin-reviewer/u,
    );
    await expect(page.getByLabel("Situation MDX")).toHaveValue(
      new RegExp(`lastReviewed: ${new Date().toISOString().slice(0, 10)}`, "u"),
    );
    await expect(
      page.getByRole("button", { name: "Approve exact bundle" }),
    ).toBeDisabled();
    const prepared = await database.query<{
      id: string;
      parent_bundle_id: string;
      state: string;
    }>(
      `SELECT id, parent_bundle_id, state
       FROM proposed_bundles
       WHERE parent_bundle_id = $1`,
      [bundleId],
    );
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.rows[0]?.state).toBe("HUMAN_REVIEW");
    const original = await database.query<{ state: string }>(
      "SELECT state FROM proposed_bundles WHERE id = $1",
      [bundleId],
    );
    expect(original.rows[0]?.state).toBe("STALE");
    await page.goto("/");
    const candidateCard = page.locator(
      `.situationCard[href='/situations/${slug}']`,
    );
    await expect(candidateCard).toHaveClass(/attentionCard/u);
    await page.getByRole("checkbox", { name: "Needs attention" }).check();
    await expect(candidateCard).toBeVisible();

    await database.query(
      `UPDATE proposed_bundles
       SET state = 'STALE'
       WHERE parent_bundle_id = $1`,
      [bundleId],
    );

    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page, "studio-editor");
    await page.goto(`/situations/${slug}`);
    await expect(page.getByRole("button", { name: "Check in" })).toBeVisible();
    await page.getByRole("tab", { name: "Source MDX" }).click();
    const checkedOutSource = page.getByLabel("Situation MDX");
    const unsavedSentinel = `Unsaved check-in sentinel ${testInfo.project.name}`;
    await checkedOutSource.fill(
      `${await checkedOutSource.inputValue()}\n\n${unsavedSentinel}`,
    );
    await expect(page.getByRole("status")).toContainText(
      "check in to discard them",
    );

    page.once("dialog", async (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByRole("status")).toContainText("Check-in cancelled");
    await expect(checkedOutSource).toHaveValue(
      new RegExp(unsavedSentinel, "u"),
    );

    page.once("dialog", async (dialog) => dialog.accept());
    const [releaseResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/api/checkouts/") &&
          response.url().endsWith("/release"),
      ),
      page.getByRole("button", { name: "Check in" }).click(),
    ]);
    expect(releaseResponse.status()).toBe(200);
    await expect(
      page.getByRole("button", { name: "Check out for editing" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Source MDX" }).click();
    await expect(page.getByLabel("Situation MDX")).not.toHaveValue(
      new RegExp(unsavedSentinel, "u"),
    );
    await expect(page.getByLabel("Situation MDX")).toHaveValue(
      new RegExp(sentinel, "u"),
    );

    const releasedCheckout = await database.query<{
      released_at: Date | null;
      release_reason: string | null;
    }>(
      `SELECT released_at, release_reason
       FROM situation_checkouts
       WHERE situation_id = $1
       ORDER BY acquired_at DESC
       LIMIT 1`,
      [situationId],
    );
    expect(releasedCheckout.rows[0]?.released_at).not.toBeNull();
    expect(releasedCheckout.rows[0]?.release_reason).toBe("USER_CHECK_IN");

    if (testInfo.project.name === "desktop-1280") {
      const preparedBundleId = prepared.rows[0]?.id;
      expect(preparedBundleId).toBeDefined();
      if (!preparedBundleId) return;
      await database.query(
        `UPDATE proposed_bundles
         SET state = 'HUMAN_REVIEW'
         WHERE id = $1`,
        [preparedBundleId],
      );
      await page.getByRole("button", { name: "Sign out" }).click();
      await login(page);
      await page.goto(`/situations/${slug}`);
      const [resolveResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes("/api/comments/") &&
            response.url().endsWith("/resolve"),
        ),
        page.getByRole("button", { name: "Resolve" }).click(),
      ]);
      expect(resolveResponse.status()).toBe(200);
      const [approvalResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith(`/api/bundles/${preparedBundleId}/approve`),
        ),
        page.getByRole("button", { name: "Approve exact bundle" }).click(),
      ]);
      expect(approvalResponse.status()).toBe(200);
      await expect(
        page.getByRole("button", { name: "Stage approved bundle" }),
      ).toBeVisible();
      await expect(page.locator(".workspaceSummary")).toContainText(
        "No active owner",
      );
      const [stageResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/api/publications"),
        ),
        page.getByRole("button", { name: "Stage approved bundle" }).click(),
      ]);
      expect(stageResponse.status()).toBe(201);
      const staged = await database.query<{
        custody: string;
        id: string;
        state: string;
      }>(
        `SELECT checkout.custody, request.id, request.state
         FROM publication_requests AS request
         JOIN situation_checkouts AS checkout
           ON checkout.custody_reference = request.id
         WHERE request.bundle_id = $1
           AND checkout.released_at IS NULL`,
        [preparedBundleId],
      );
      expect(staged.rows).toHaveLength(1);
      expect(staged.rows[0]?.custody).toBe("PUBLISHER");
      expect(["REQUESTED", "AWAITING_CONFIRMATION"]).toContain(
        staged.rows[0]?.state,
      );
      const stagedRequestId = staged.rows[0]?.id;
      expect(stagedRequestId).toBeDefined();
      if (!stagedRequestId) return;
      const stagedCommit = "b".repeat(40);
      await database.query("BEGIN");
      try {
        await database.query(
          `UPDATE publication_requests
           SET state = 'AWAITING_CONFIRMATION',
               current_step = 'PREVIEW_VERIFIED'
           WHERE id = $1`,
          [stagedRequestId],
        );
        await database.query(
          `UPDATE drafts
           SET state = 'PUBLISHING'
           WHERE id = (
             SELECT draft_id
             FROM proposed_bundles
             WHERE id = $1
           )`,
          [preparedBundleId],
        );
        await database.query(
          `INSERT INTO publication_steps
           (id, request_id, step, attempt, fence, external_id, state, input_hash,
            finished_at)
           VALUES ($1, $2, 'COMMITTED', 1, 1, $3, 'SUCCEEDED', $4, NOW())
           ON CONFLICT (request_id, step, attempt)
           DO UPDATE SET external_id = EXCLUDED.external_id,
                         state = EXCLUDED.state,
                         input_hash = EXCLUDED.input_hash,
                         finished_at = EXCLUDED.finished_at`,
          [randomUUID(), stagedRequestId, stagedCommit, fixtureHash("commit")],
        );
        await database.query("COMMIT");
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      }

      await page.goto(`/situations/${slug}`);
      await expect(
        page.getByRole("heading", {
          name: "Leadership is displaying the staged candidate",
        }),
      ).toBeVisible();
      await expect(page.locator(".workspaceSummary")).toContainText(
        "Official baseline",
      );
      await expect(page.locator(".workspaceSummary")).toContainText(
        "Staged candidate",
      );
      await expect(page.locator(".workspaceSummary")).toContainText(
        "not yet official",
      );
      await page
        .getByRole("button", { name: "Confirm and publish bbbbbbbb" })
        .click();
      const publicationDialog = page.getByRole("dialog");
      await expect(publicationDialog).toContainText(
        "Leadership already displays this reviewed candidate",
      );
      await expect(publicationDialog).toContainText(
        "It will not build another version",
      );
      const reviewConfirmation = page.getByLabel(
        "I reviewed the exact candidate and want to publish it.",
      );
      await expect(reviewConfirmation).toBeFocused();
      const publishConfirmation = publicationDialog.getByRole("button", {
        name: "Confirm and publish bbbbbbbb",
      });
      await expect(publishConfirmation).toBeDisabled();
      const modalAccessibility = await new AxeBuilder({ page })
        .include(".publicationConfirmationDialog")
        .analyze();
      expect(
        modalAccessibility.violations.filter((violation) =>
          ["critical", "serious"].includes(violation.impact ?? ""),
        ),
      ).toEqual([]);
      await reviewConfirmation.check();
      await expect(publishConfirmation).toBeEnabled();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(publicationDialog).toHaveCount(0);
      const unconfirmed = await database.query<{
        final_confirmed_at: Date | null;
      }>(
        `SELECT final_confirmed_at
         FROM publication_requests
         WHERE id = $1`,
        [stagedRequestId],
      );
      expect(unconfirmed.rows[0]?.final_confirmed_at).toBeNull();
      await database.query(
        `UPDATE publication_requests
         SET final_confirmed_at = NOW()
         WHERE id = $1`,
        [stagedRequestId],
      );
      await page.goto(`/situations/${slug}`);
      await expect(
        page.getByRole("heading", {
          name: "Publishing exact candidate bbbbbbbb",
        }),
      ).toBeVisible();
      await expect(
        page.locator(".publicationProgress li.complete"),
      ).toHaveCount(1);
      await expect(page.locator(".publicationProgress li.current")).toHaveCount(
        1,
      );
      await database.query(
        `UPDATE publication_requests
         SET state = 'CUTOVER', current_step = 'CUTOVER'
         WHERE id = $1`,
        [stagedRequestId],
      );
      await page.reload();
      await expect(
        page.locator(".publicationProgress li.complete"),
      ).toHaveCount(2, { timeout: 8_000 });
      await expect(page.locator(".publicationProgress li.current")).toHaveCount(
        1,
      );
      await database.query(
        `UPDATE publication_requests
         SET state = 'LIVE_VERIFIED', current_step = 'LIVE_VERIFIED'
         WHERE id = $1`,
        [stagedRequestId],
      );
      await page.reload();
      await expect(
        page.locator(".publicationProgress li.complete"),
      ).toHaveCount(3, { timeout: 8_000 });
      await expect(page.locator(".publicationProgress li.current")).toHaveCount(
        1,
      );
      await expect(page.locator(".publicationProgress")).toContainText(
        "Studio reconciled and custody released",
      );
    }
  } finally {
    const releasedAt = new Date();
    if (bundleId)
      await database.query(
        `UPDATE publication_requests
         SET state = 'FAILED_PREVIEW',
             current_step = 'DESKTOP_UX_FIXTURE_CLEANUP',
             error_class = 'TEST_FIXTURE_CLEANUP',
             reconciliation_reason = 'Disposable browser fixture completed.'
         WHERE bundle_id IN (
           SELECT id
           FROM proposed_bundles
           WHERE id = $1 OR parent_bundle_id = $1
         )
           AND state IN (
             'REQUESTED', 'WORKTREE_READY', 'APPLIED', 'VALIDATED',
             'COMMITTED', 'PUSHED', 'PREVIEW_BUILT', 'PREVIEW_VERIFIED',
             'AWAITING_CONFIRMATION', 'CUTOVER', 'LIVE_VERIFIED',
             'RECONCILIATION_REQUIRED'
           )`,
        [bundleId],
      );
    if (situationId) {
      await database.query(
        `UPDATE checkout_resources AS resource
         SET released_at = $1
         FROM situation_checkouts AS checkout
         WHERE resource.checkout_id = checkout.id
           AND checkout.situation_id = $2
           AND resource.released_at IS NULL`,
        [releasedAt, situationId],
      );
      await database.query(
        `UPDATE situation_checkouts
         SET released_at = $1, release_reason = 'DESKTOP_UX_FIXTURE_CLEANUP'
         WHERE situation_id = $2 AND released_at IS NULL`,
        [releasedAt, situationId],
      );
    }
    if (bundleId)
      await database.query(
        `UPDATE proposed_bundles
         SET state = 'STALE'
         WHERE id = $1 OR parent_bundle_id = $1`,
        [bundleId],
      );
    if (situationId)
      await database.query(
        "UPDATE drafts SET active = false WHERE situation_id = $1 AND active = true",
        [situationId],
      );
    await database.end();
  }
});
