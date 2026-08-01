import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  bundleHash,
  canonicalJson,
  canonicalText,
  parseSituationSections,
  reviewStages,
  serializeSituationSections,
  sha256,
  situationBundleSchema,
} from "@situation-studio/domain";

const databaseUrl =
  process.env.STUDIO_BROWSER_DATABASE_URL ?? process.env.STUDIO_DATABASE_URL;
const adminPassword = process.env.STUDIO_BROWSER_ADMIN_PASSWORD;
if (!databaseUrl || !adminPassword)
  throw new Error(
    "Browser tests require STUDIO_BROWSER_DATABASE_URL and STUDIO_BROWSER_ADMIN_PASSWORD.",
  );

const database = new Client({ connectionString: databaseUrl });
const browserBackupReceiptId = randomUUID();

type ReviewFixtureInput = {
  situationId: string;
  checkoutId: string;
  checkoutFence: string;
  revisionId: string;
  inputBundleHash: string;
  contractVersion: string;
  validationPolicy: string;
  body: string;
  bundleManifest: unknown;
  candidateBody: string;
  proposalSummary?: string;
  findings: Array<{
    key: string;
    severity: "NOTE" | "CONSIDER" | "IMPORTANT" | "BLOCKING";
    targetKind:
      | "SECTION"
      | "METADATA"
      | "SCOPED_VARIANT"
      | "RELATIONSHIP"
      | "EMBED"
      | "BUNDLE";
    targetKey: string;
    summary: string;
    rationale: string;
    sourceRoleCode: string;
    evidenceRoleCodes: string[];
  }>;
  changes: Array<{
    id: string;
    targetKind:
      | "SECTION"
      | "METADATA"
      | "SCOPED_VARIANT"
      | "RELATIONSHIP"
      | "EMBED"
      | "BUNDLE";
    targetKey: string;
    applicationMode: "AUTOMATIC" | "MANUAL";
    beforeHash: string | null;
    beforeBody: string | null;
    afterBody: string;
    problem: string;
    explanation: string;
    rationale: string;
    findingKeys: string[];
    writtenByRoleCode: string;
    identifiedByRoleCodes: string[];
    evidenceRoleCodes: string[];
  }>;
};

async function insertSucceededReviewFixture(input: ReviewFixtureInput) {
  const jobId = randomUUID();
  const proposalId = randomUUID();
  const candidateId = randomUUID();
  const candidateBundle = situationBundleSchema.parse({
    ...situationBundleSchema.parse(input.bundleManifest),
    bodyHash: sha256(canonicalText(input.candidateBody)),
  });
  const candidateBundleHash = bundleHash(candidateBundle);
  const candidateHash = sha256(
    canonicalJson({
      inputRevisionId: input.revisionId,
      inputBundleHash: input.inputBundleHash,
      body: canonicalText(input.candidateBody),
      bundle: candidateBundle,
    }),
  );
  const findingIds = new Map(
    input.findings.map((finding) => [finding.key, randomUUID()]),
  );
  await database.query("BEGIN");
  try {
    await database.query(
      `INSERT INTO review_jobs (
         id, situation_id, input_revision_id, checkout_id, checkout_fence,
         state, context_hash, contract_version, policy_version,
         queued_at, started_at, finished_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'SUCCEEDED', $6, $7, $8, now(), now(), now()
       )`,
      [
        jobId,
        input.situationId,
        input.revisionId,
        input.checkoutId,
        input.checkoutFence,
        createHash("sha256").update(jobId).digest("hex"),
        input.contractVersion,
        input.validationPolicy,
      ],
    );
    for (const stage of reviewStages)
      await database.query(
        `INSERT INTO review_steps (
           id, job_id, ordinal, role_code, dependencies, state,
           output_hash, started_at, finished_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'SUCCEEDED', $6, now(), now())`,
        [
          randomUUID(),
          jobId,
          stage.ordinal,
          stage.role,
          JSON.stringify(stage.dependencies),
          createHash("sha256")
            .update(`${jobId}:${stage.ordinal}`)
            .digest("hex"),
        ],
      );
    await database.query(
      `INSERT INTO review_proposals (
         id, job_id, input_revision_id, summary, findings, proposal_hash
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        proposalId,
        jobId,
        input.revisionId,
        input.proposalSummary ??
          (input.changes.length
            ? "A concise candidate revision with retained worker lineage."
            : "The review found issues but did not generate a safe automatic edit."),
        JSON.stringify(input.findings),
        createHash("sha256").update(proposalId).digest("hex"),
      ],
    );
    await database.query(
      `INSERT INTO agent_candidate_revisions (
         id, proposal_id, input_revision_id, input_bundle_hash, body,
         body_hash, bundle_manifest, bundle_hash, candidate_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        candidateId,
        proposalId,
        input.revisionId,
        input.inputBundleHash,
        canonicalText(input.candidateBody),
        candidateBundle.bodyHash,
        JSON.stringify(candidateBundle),
        candidateBundleHash,
        candidateHash,
      ],
    );
    for (const [position, finding] of input.findings.entries())
      await database.query(
        `INSERT INTO review_findings (
           id, proposal_id, position, finding_key, severity, target_kind,
           target_key, summary, rationale, source_role_code,
           evidence_role_codes
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
         )`,
        [
          findingIds.get(finding.key),
          proposalId,
          position,
          finding.key,
          finding.severity,
          finding.targetKind,
          finding.targetKey,
          finding.summary,
          finding.rationale,
          finding.sourceRoleCode,
          JSON.stringify(finding.evidenceRoleCodes),
        ],
      );
    for (const [position, change] of input.changes.entries()) {
      await database.query(
        `INSERT INTO proposal_changes (
           id, proposal_id, position, target_kind, target_key,
           application_mode, before_hash, before_body, after_body, after_hash,
           problem, explanation, rationale, written_by_role_code,
           identified_by_role_codes, evidence_role_codes
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15::jsonb, $16::jsonb
         )`,
        [
          change.id,
          proposalId,
          position,
          change.targetKind,
          change.targetKey,
          change.applicationMode,
          change.beforeHash,
          change.beforeBody,
          change.afterBody,
          sha256(change.afterBody),
          change.problem,
          change.explanation,
          change.rationale,
          change.writtenByRoleCode,
          JSON.stringify(change.identifiedByRoleCodes),
          JSON.stringify(change.evidenceRoleCodes),
        ],
      );
      for (const findingKey of change.findingKeys) {
        const findingId = findingIds.get(findingKey);
        if (!findingId)
          throw new Error(`Browser finding ${findingKey} is unavailable.`);
        await database.query(
          `INSERT INTO proposal_change_findings (change_id, finding_id)
           VALUES ($1, $2)`,
          [change.id, findingId],
        );
      }
    }
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
  return { jobId, proposalId, candidateHash };
}

async function signIn(
  page: Page,
  returnTo = "/",
  username = "admin",
  password = adminPassword,
) {
  await page.goto(returnTo);
  await expect(page).toHaveURL(/\/login/u);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/u);
}

async function expectNoCriticalAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect(
    serious,
    serious
      .map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`,
      )
      .join("\n"),
  ).toEqual([]);
}

async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function cleanupBrowserFixture(
  checkoutId: string,
  publicationJobIds: string[] = [],
) {
  await database.query("BEGIN");
  try {
    if (publicationJobIds.length > 0) {
      await database.query(
        "DELETE FROM publication_events WHERE job_id = ANY($1::uuid[])",
        [publicationJobIds],
      );
      await database.query(
        "DELETE FROM publication_jobs WHERE id = ANY($1::uuid[])",
        [publicationJobIds],
      );
    }
    await database.query(
      `UPDATE review_steps
          SET state = 'CANCELLED',
              finished_at = COALESCE(finished_at, now())
        WHERE job_id IN (
                SELECT id FROM review_jobs WHERE checkout_id = $1
              )
          AND state IN ('PENDING', 'READY', 'RUNNING')`,
      [checkoutId],
    );
    await database.query(
      `UPDATE review_jobs
          SET state = 'CANCELLED',
              lane_owner = false,
              claim_token = NULL,
              lease_expires_at = NULL,
              retry_not_before = NULL,
              cancelled_at = COALESCE(cancelled_at, now()),
              cancellation_reason = COALESCE(
                cancellation_reason,
                'Browser fixture cleanup'
              ),
              finished_at = COALESCE(finished_at, now())
        WHERE checkout_id = $1
          AND state IN ('QUEUED', 'RUNNING', 'FAILED')`,
      [checkoutId],
    );
    await database.query(
      `UPDATE situation_checkouts
          SET released_at = COALESCE(released_at, now()),
              release_reason = COALESCE(
                release_reason,
                'Browser fixture cleanup'
              )
        WHERE id = $1`,
      [checkoutId],
    );
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

test.afterAll(async () => {
  try {
    await database.query("DELETE FROM backup_receipts WHERE id = $1", [
      browserBackupReceiptId,
    ]);
  } finally {
    await database.end();
  }
});

test.beforeAll(async () => {
  await database.connect();
  await database.query(
    `INSERT INTO backup_receipts (
       id, state, destination_id, object_key, checksum, encrypted, byte_length,
       verified_at, restore_drill_at, restore_drill_result
     ) VALUES (
       $1, 'VERIFIED', 'offsite-verified:${"c".repeat(64)}',
       'situation-studio-browser.dump.gpg', $2, true, 1, now(), now(), 'PASSED'
     )`,
    [browserBackupReceiptId, "d".repeat(64)],
  );
});

test("rejects off-site return destinations and exposes no public signup", async ({
  page,
}) => {
  const unauthenticatedStream = await page.request.get(
    "/api/reviews/11111111-1111-4111-8111-111111111111/events",
  );
  expect(unauthenticatedStream.status()).toBe(401);
  await expect(unauthenticatedStream.json()).resolves.toEqual({
    error: "Authentication required.",
  });
  await page.goto("/auth/login/begin?returnTo=%2F%2Fattacker.example%2Fsteal");
  await expect(page).toHaveURL("http://localhost:3015/login");
  await expect(
    page.getByRole("heading", { name: "Sign in to edit with care." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /sign up|register/iu }),
  ).toHaveCount(0);
  await expectNoCriticalAccessibilityViolations(page);
  await expectNoPageOverflow(page);
});

test("inventory, operations, and new-situation surfaces remain accessible", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: /Choose one situation/u }),
  ).toBeVisible();
  await expect(
    page.getByText("check out, edit or run a review, then submit"),
  ).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  await page.goto("/operations");
  await expect(
    page.getByRole("heading", { name: "Keep the workbench healthy." }),
  ).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  await page.goto("/situations/new");
  await expect(
    page.getByRole("heading", { name: "Begin with the real moment." }),
  ).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await expectNoPageOverflow(page);
});

test("agent revisions render as accessible diffs with fenced decisions and honest no-change findings", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page, "/situations/new");
  const suffix = `${testInfo.project.name}-${Date.now()}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-");
  const title = `Browser agent revision ${suffix}`;
  const slug = `browser-agent-revision-${suffix}`;
  const titleInput = page.getByLabel("Working title");
  await expect
    .poll(() =>
      titleInput.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await titleInput.fill(title);
  await page.getByLabel("Stable slug").fill(slug);
  await expect(titleInput).toHaveValue(title);
  await page.getByRole("button", { name: "Create and check out" }).click();
  await expect(page).toHaveURL(new RegExp(`/situations/${slug}$`, "u"));

  const fixtureResult = await database.query<{
    situation_id: string;
    checkout_id: string;
    checkout_fence: string;
    draft_id: string;
    revision_id: string;
    bundle_hash: string;
    contract_version: string;
    validation_policy: string;
    bundle_manifest: unknown;
    text_body: string;
  }>(
    `SELECT situation.id AS situation_id,
            checkout.id AS checkout_id,
            checkout.fence::text AS checkout_fence,
            draft.id AS draft_id,
            revision.id AS revision_id,
            revision.bundle_hash,
            revision.contract_version,
            revision.validation_policy,
            revision.bundle_manifest,
            content.text_body
       FROM situations situation
       JOIN situation_checkouts checkout
         ON checkout.situation_id = situation.id
        AND checkout.released_at IS NULL
       JOIN drafts draft ON draft.id = checkout.draft_id
       JOIN LATERAL (
         SELECT *
           FROM draft_revisions candidate
          WHERE candidate.draft_id = draft.id
          ORDER BY candidate.revision DESC
          LIMIT 1
       ) revision ON true
       JOIN draft_revision_artifacts artifact
         ON artifact.revision_id = revision.id
        AND artifact.kind = 'SITUATION'
       JOIN content_blobs content ON content.hash = artifact.content_hash
      WHERE situation.slug = $1`,
    [slug],
  );
  const fixture = fixtureResult.rows[0];
  if (!fixture) throw new Error("Browser candidate fixture is unavailable.");
  const sections = parseSituationSections(fixture.text_body);
  const originalShortAnswer = sections["The short answer"];
  const agentShortAnswer =
    "Name the directly observed pattern, ask for their view, and agree on one dated next move.";
  const candidateBody = serializeSituationSections({
    ...sections,
    "The short answer": agentShortAnswer,
  });
  const automaticId = randomUUID();
  const manualId = randomUUID();
  await insertSucceededReviewFixture({
    situationId: fixture.situation_id,
    checkoutId: fixture.checkout_id,
    checkoutFence: fixture.checkout_fence,
    revisionId: fixture.revision_id,
    inputBundleHash: fixture.bundle_hash,
    contractVersion: fixture.contract_version,
    validationPolicy: fixture.validation_policy,
    body: fixture.text_body,
    bundleManifest: fixture.bundle_manifest,
    candidateBody,
    findings: [
      {
        key: "critic-nvc:observable-opening",
        severity: "IMPORTANT",
        targetKind: "SECTION",
        targetKey: "The short answer",
        summary: "The opening should distinguish observation from judgment.",
        rationale:
          "Observable language makes the conversation more specific and easier to answer.",
        sourceRoleCode: "critic-nvc",
        evidenceRoleCodes: ["critic-manager-tools"],
      },
      {
        key: "critic-coaching:contextual-example",
        severity: "CONSIDER",
        targetKind: "EMBED",
        targetKey: "contextual-example",
        summary: "A useful example depends on the editor's real context.",
        rationale:
          "The review cannot safely invent the people, facts, or stakes for an embed.",
        sourceRoleCode: "critic-coaching",
        evidenceRoleCodes: [],
      },
    ],
    changes: [
      {
        id: automaticId,
        targetKind: "SECTION",
        targetKey: "The short answer",
        applicationMode: "AUTOMATIC",
        beforeHash: sha256(canonicalText(originalShortAnswer)),
        beforeBody: originalShortAnswer,
        afterBody: agentShortAnswer,
        problem: "The opening relies on a broad interpretation.",
        explanation: "Makes the opening observable and adds a dated next move.",
        rationale:
          "The Bundle Writer responded to the NVC finding with Manager Tools evidence.",
        findingKeys: ["critic-nvc:observable-opening"],
        writtenByRoleCode: "bundle-writer",
        identifiedByRoleCodes: ["critic-nvc"],
        evidenceRoleCodes: ["critic-nvc", "critic-manager-tools"],
      },
      {
        id: manualId,
        targetKind: "EMBED",
        targetKey: "contextual-example",
        applicationMode: "MANUAL",
        beforeHash: null,
        beforeBody: null,
        afterBody: "Choose a truthful contextual example in the editor.",
        problem: "No safe generic embed is available.",
        explanation: "Keeps the embed as an explicit manual suggestion.",
        rationale:
          "The review retains the comment instead of inventing unsupported content.",
        findingKeys: ["critic-coaching:contextual-example"],
        writtenByRoleCode: "bundle-writer",
        identifiedByRoleCodes: ["critic-coaching"],
        evidenceRoleCodes: ["critic-coaching"],
      },
    ],
  });

  await page.goto(`/situations/${slug}?tab=review`);
  await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "2 suggested changes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept all (1)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reject all (2)" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Saved draft and agent revision comparison"),
  ).toHaveCount(0);
  const automaticHunk = page
    .locator("article.reviewHunk")
    .filter({ hasText: "The short answer" });
  await expect(automaticHunk.locator(".diffLineAdded pre")).toContainText(
    "directly observed",
  );
  await expect(automaticHunk.locator(".diffLineRemoved pre")).toContainText(
    originalShortAnswer,
  );
  await automaticHunk.getByText("View explanation").click();
  await expect(automaticHunk).toContainText("Nonviolent Communication");
  await expect(automaticHunk).toContainText("Bundle Writer");
  await expect(automaticHunk).toContainText("Manager Tools");

  await automaticHunk.getByRole("button", { name: "Edit suggestion" }).click();
  await expect(
    automaticHunk.getByLabel("Edit the proposed replacement"),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    automaticHunk.getByLabel("Edit the proposed replacement"),
  ).toHaveCount(0);
  await automaticHunk.getByRole("button", { name: "Edit suggestion" }).click();
  const editorReplacement =
    "Name one directly observed pattern, ask for their view, and agree on one dated follow-up.";
  await automaticHunk
    .getByLabel("Edit the proposed replacement")
    .fill(editorReplacement);
  await automaticHunk
    .getByRole("button", { name: "Save edited suggestion" })
    .click();
  await expect(automaticHunk.getByText("Modified by editor")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page
      .locator("article.reviewHunk")
      .filter({ hasText: "The short answer" })
      .getByText("Modified by editor"),
  ).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await expectNoPageOverflow(page);

  const beforeAcceptance = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM draft_revisions WHERE draft_id = $1",
    [fixture.draft_id],
  );
  await page.getByRole("button", { name: "Accept all (1)" }).click();
  await expect(page.getByRole("button", { name: /^Accept all/u })).toHaveCount(
    0,
  );
  await expect(
    page.locator("article.reviewHunk").filter({ hasText: "The short answer" }),
  ).toContainText("accepted");
  const manualHunk = page
    .locator("article.reviewHunk")
    .filter({ hasText: "contextual-example" });
  await expect(manualHunk.getByText("Manual only")).toBeVisible();
  await manualHunk.getByRole("button", { name: "Reject" }).click();
  await expect(manualHunk).toContainText("rejected");
  const afterAcceptance = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM draft_revisions WHERE draft_id = $1",
    [fixture.draft_id],
  );
  expect(Number(afterAcceptance.rows[0]?.count)).toBe(
    Number(beforeAcceptance.rows[0]?.count) + 1,
  );
  const decisions = await database.query<{
    id: string;
    state: string;
    editor_body: string | null;
  }>(
    `SELECT id, state::text, editor_body
       FROM proposal_changes
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [[automaticId, manualId]],
  );
  expect(decisions.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: automaticId,
        state: "ACCEPTED",
        editor_body: editorReplacement,
      }),
      expect.objectContaining({ id: manualId, state: "REJECTED" }),
    ]),
  );

  const latestResult = await database.query<{
    revision_id: string;
    bundle_hash: string;
    contract_version: string;
    validation_policy: string;
    bundle_manifest: unknown;
    text_body: string;
  }>(
    `SELECT revision.id AS revision_id,
            revision.bundle_hash,
            revision.contract_version,
            revision.validation_policy,
            revision.bundle_manifest,
            content.text_body
       FROM draft_revisions revision
       JOIN draft_revision_artifacts artifact
         ON artifact.revision_id = revision.id
        AND artifact.kind = 'SITUATION'
       JOIN content_blobs content ON content.hash = artifact.content_hash
      WHERE revision.draft_id = $1
      ORDER BY revision.revision DESC
      LIMIT 1`,
    [fixture.draft_id],
  );
  const latest = latestResult.rows[0];
  if (!latest) throw new Error("Accepted browser revision is unavailable.");
  await insertSucceededReviewFixture({
    situationId: fixture.situation_id,
    checkoutId: fixture.checkout_id,
    checkoutFence: fixture.checkout_fence,
    revisionId: latest.revision_id,
    inputBundleHash: latest.bundle_hash,
    contractVersion: latest.contract_version,
    validationPolicy: latest.validation_policy,
    body: latest.text_body,
    bundleManifest: latest.bundle_manifest,
    candidateBody: latest.text_body,
    proposalSummary:
      "This deliberately detailed overall rationale should stay collapsed until the editor asks to read it.",
    findings: [
      {
        key: "critic-coaching:no-safe-edit",
        severity: "BLOCKING",
        targetKind: "SECTION",
        targetKey: "3 — Say",
        summary: "The right example depends on facts not present in evidence.",
        rationale:
          "The editor should anchor a real example before changing the draft.",
        sourceRoleCode: "critic-coaching",
        evidenceRoleCodes: ["critic-nvc"],
      },
    ],
    changes: [],
  });
  await page.reload();
  await expect(
    page.getByText("No safe automatic change was generated."),
  ).toBeVisible();
  const overallRationale = page.getByText("View overall review rationale");
  await expect(
    page.getByText(
      "This deliberately detailed overall rationale should stay collapsed until the editor asks to read it.",
    ),
  ).not.toBeVisible();
  await overallRationale.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "This deliberately detailed overall rationale should stay collapsed until the editor asks to read it.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "This deliberately detailed overall rationale should stay collapsed until the editor asks to read it.",
    ),
  ).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^Accept all/u })).toHaveCount(
    0,
  );
  await page.getByText("Other review findings (1)").click();
  await expect(page.locator(".inlineFindings")).toContainText("3 — Say");
  await expectNoCriticalAccessibilityViolations(page);
  await expectNoPageOverflow(page);
});

test("durable checkout, autosave, preview, dialog focus, and check-in work end to end", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1280",
    "Run the mutation path once.",
  );
  const situationResult = await database.query<{ id: string }>(
    "SELECT id FROM situations WHERE slug = $1",
    ["defensive-about-feedback"],
  );
  const situation = situationResult.rows[0];
  if (!situation) throw new Error("Browser fixture situation is unavailable.");
  await database.query(
    `UPDATE situation_checkouts
        SET released_at = now(), release_reason = 'BROWSER_TEST_SETUP'
      WHERE situation_id = $1 AND released_at IS NULL`,
    [situation.id],
  );

  await signIn(page);
  const row = page
    .locator("article.inventoryRow")
    .filter({ hasText: "defensive-about-feedback" });
  await row.getByRole("button", { name: "Check out" }).click();
  await expect(page).toHaveURL(/\/situations\/defensive-about-feedback$/u);
  await expect(page.getByText("Checked out to you")).toBeVisible();

  const title = page.getByLabel("Title");
  const originalTitle = await title.inputValue();
  const changedTitle = `${originalTitle.replace(
    /(?: — browser verified)+$/u,
    "",
  )} — browser verified`;
  await title.fill(changedTitle);
  await title.blur();
  await expect(page.getByRole("status")).toContainText("All changes saved", {
    timeout: 15_000,
  });
  await page.reload();
  await expect(page.getByLabel("Title")).toHaveValue(changedTitle);
  await expect(
    page.getByRole("heading", { name: "Leadership rendering" }),
  ).toBeVisible();

  const reviewTab = page.getByRole("tab", { name: "Review" });
  await reviewTab.click();
  await expect(reviewTab).toBeFocused();
  await expect(page).toHaveURL(/[?&]tab=review(?:&|$)/u);
  await expect(page.getByText("Exact source diff")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("Exact source diff")).toBeVisible();
  await reviewTab.click();
  await page.keyboard.press("ArrowRight");
  const historyTab = page.getByRole("tab", { name: /History/u });
  await expect(historyTab).toBeFocused();
  await expect(page).toHaveURL(/[?&]tab=history(?:&|$)/u);
  await page.keyboard.press("ArrowLeft");
  await expect(reviewTab).toBeFocused();
  await expect(page).toHaveURL(/[?&]tab=review(?:&|$)/u);
  await expectNoCriticalAccessibilityViolations(page);

  const submit = page.getByRole("button", { name: "Submit to production" });
  await submit.click();
  const dialog = page.getByRole("dialog", {
    name: "Submit this situation to Leadership?",
  });
  const keepEditing = dialog.getByRole("button", { name: "Keep editing" });
  const confirm = dialog.getByRole("button", { name: "Confirm submission" });
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(submit).toBeFocused();

  await page.route("**/api/checkouts/*/publish", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/html",
      body: "<h1>Unexpected server failure</h1>",
    });
  });
  await submit.click();
  await dialog.getByRole("button", { name: "Confirm submission" }).click();
  await expect(page.locator(".actionError")).toContainText(
    "The action could not be completed.",
  );
  await expect(page.getByRole("heading", { name: changedTitle })).toBeVisible();
  await page.unroute("**/api/checkouts/*/publish");

  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page).toHaveURL("http://localhost:3015/");
  await expect(
    page
      .locator("article.inventoryRow")
      .filter({ hasText: "defensive-about-feedback" })
      .getByRole("button", { name: "Check out" }),
  ).toBeVisible();
  const active = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM situation_checkouts WHERE situation_id = $1 AND released_at IS NULL",
    [situation.id],
  );
  expect(Number(active.rows[0]?.count)).toBe(0);
  const latest = await database.query<{ bundle_manifest: unknown }>(
    `SELECT revision.bundle_manifest
       FROM drafts draft
       JOIN draft_revisions revision ON revision.draft_id = draft.id
      WHERE draft.situation_id = $1 AND draft.state = 'ACTIVE'
      ORDER BY draft.lineage DESC, revision.revision DESC
      LIMIT 1`,
    [situation.id],
  );
  expect(latest.rows[0]?.bundle_manifest).toMatchObject({
    metadata: { title: changedTitle },
  });
});

test("workspace streams worker progress, retry, terminal, and proposal state without reload", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1280",
    "Run the retry-state mutation path once.",
  );
  const candidate = await database.query<{ id: string; slug: string }>(
    `SELECT situation.id, situation.slug
       FROM situations situation
      WHERE NOT EXISTS (
              SELECT 1
                FROM situation_checkouts checkout
               WHERE checkout.situation_id = situation.id
                 AND checkout.released_at IS NULL
            )
        AND NOT EXISTS (
              SELECT 1
                FROM review_jobs review
               WHERE review.situation_id = situation.id
                 AND review.state IN ('QUEUED', 'RUNNING')
            )
        AND situation.slug <> 'defensive-about-feedback'
      ORDER BY situation.slug
      LIMIT 1`,
  );
  const situation = candidate.rows[0];
  if (!situation)
    throw new Error("Browser retry-state fixture situation is unavailable.");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  const row = page
    .locator("article.inventoryRow")
    .filter({ hasText: situation.slug });
  await row.getByRole("button", { name: "Check out" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/situations/${situation.slug}$`, "u"),
  );
  const checkoutResult = await database.query<{ id: string }>(
    `SELECT id
       FROM situation_checkouts
      WHERE situation_id = $1
        AND released_at IS NULL`,
    [situation.id],
  );
  const browserCheckout = checkoutResult.rows[0];
  if (!browserCheckout)
    throw new Error("Browser retry-state checkout is unavailable.");
  try {
    const streamConnected = page.waitForResponse(
      (response) =>
        response.url().includes("/api/reviews/") &&
        response.url().endsWith("/events") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Run agent review" }).click();
    await expect(page.getByText("Review queued")).toBeVisible();
    const streamResponse = await streamConnected;
    expect(streamResponse.headers()["content-type"]).toContain(
      "text/event-stream",
    );
    expect(streamResponse.headers()["cache-control"]).toContain("no-transform");

    const jobResult = await database.query<{
      id: string;
      input_revision_id: string;
    }>(
      `SELECT id, input_revision_id
       FROM review_jobs
      WHERE situation_id = $1
        AND state = 'QUEUED'
      ORDER BY queued_at DESC
      LIMIT 1`,
      [situation.id],
    );
    const job = jobResult.rows[0];
    if (!job) throw new Error("Browser retry-state review was not queued.");
    const stepResult = await database.query<{
      id: string;
      role_code: string;
      ordinal: number;
    }>(
      `SELECT id, role_code, ordinal
       FROM review_steps
      WHERE job_id = $1
      ORDER BY ordinal
      LIMIT 2`,
      [job.id],
    );
    const firstStep = stepResult.rows[0];
    const activeStep = stepResult.rows[1];
    if (!firstStep || !activeStep)
      throw new Error("Browser live-review steps are unavailable.");

    await page.getByRole("tab", { name: "Review" }).click();
    const progress = page.getByRole("progressbar", {
      name: "Agent review progress",
    });
    await expect(progress).toHaveAttribute("aria-valuenow", "0");
    const pageIdentity = await page.evaluate(() => {
      const identity = crypto.randomUUID();
      Object.assign(window, { __studioLiveReviewIdentity: identity });
      return identity;
    });

    await database.query(
      `UPDATE review_jobs
        SET state = 'RUNNING',
            lane_owner = true,
            started_at = now(),
            claim_token = $2,
            lease_expires_at = now() + interval '2 minutes'
      WHERE id = $1`,
      [job.id, randomUUID()],
    );
    await database.query(
      `UPDATE review_steps
        SET state = 'SUCCEEDED',
            output_hash = $2,
            finished_at = now()
      WHERE id = $1`,
      [firstStep.id, "b".repeat(64)],
    );
    await database.query(
      `UPDATE review_steps
        SET state = 'RUNNING',
            started_at = now()
      WHERE id = $1`,
      [activeStep.id],
    );
    await database.query(
      `INSERT INTO agent_runs (
       id, step_id, attempt, requested_provider, requested_model,
       reasoning_effort, evidence_hash, started_at
     ) VALUES (
       $1, $2, 1, 'codex', 'gpt-5.6-sol', 'high', $3, now()
     )`,
      [randomUUID(), activeStep.id, "a".repeat(64)],
    );

    await expect(progress).toHaveAttribute("aria-valuenow", "1", {
      timeout: 10_000,
    });
    await expect(progress).toHaveAttribute(
      "aria-valuetext",
      "1 of 24 stages complete",
    );
    await expect(
      page.getByText("1 of 24 stages complete", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Nonviolent communication critique", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Review continues safely on the server."),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __studioLiveReviewIdentity?: string;
            }
          ).__studioLiveReviewIdentity,
      ),
    ).toBe(pageIdentity);
    await expect(page.locator(".stageRail i.active")).toHaveCSS(
      "animation-name",
      "none",
    );
    expect(
      await page
        .locator(".reviewActivityIndicator")
        .evaluate(
          (element) => getComputedStyle(element, "::after").animationName,
        ),
    ).toBe("none");

    const scheduledAt = new Date(Date.now() + 15 * 60_000);
    await database.query(
      `UPDATE review_jobs
        SET state = 'QUEUED',
            retry_not_before = $2,
            failure_code = 'TRANSIENT',
            failure_reason_code = 'PROVIDER_TRANSIENT',
            failure_phase = 'RUN_STAGE',
            failure_stage_ordinal = 2,
            failure_stage_role = 'critic-nvc',
            claim_token = NULL,
            lease_expires_at = NULL
      WHERE id = $1`,
      [job.id, scheduledAt],
    );
    await database.query(
      `UPDATE review_steps
        SET state = 'READY',
            started_at = NULL,
            finished_at = NULL
      WHERE id = $1`,
      [activeStep.id],
    );
    await database.query(
      `UPDATE agent_runs
        SET provider_attempts = $2::jsonb,
            failure_class = 'PROVIDER_TRANSIENT',
            retryable = true,
            finished_at = now()
      WHERE step_id = $1
        AND attempt = 1`,
      [
        activeStep.id,
        JSON.stringify([
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            durationMs: 90_000,
            outcome: "TIMED_OUT",
            failureClass: "TRANSIENT",
            retryable: true,
          },
        ]),
      ],
    );

    await expect(page.getByText("RETRYING", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Nonviolent communication critique", { exact: true }),
    ).toBeVisible();
    const retryStatus = page.locator(".reviewRetryStatus");
    await expect(retryStatus).toContainText(
      "The review provider was interrupted",
    );
    await expect(retryStatus).toContainText("attempt 1 of 3");
    await expect(retryStatus.locator("time")).toHaveAttribute(
      "datetime",
      scheduledAt.toISOString(),
    );
    await expect(page.locator('[aria-live="polite"]')).toContainText(
      "will retry automatically",
    );
    await expectNoCriticalAccessibilityViolations(page);

    await database.query(
      `UPDATE review_jobs
        SET state = 'FAILED',
            finished_at = now(),
            retry_not_before = NULL
      WHERE id = $1`,
      [job.id],
    );
    await database.query(
      `UPDATE review_steps
        SET state = 'FAILED',
            finished_at = now()
      WHERE id = $1`,
      [activeStep.id],
    );
    await expect(
      page.getByRole("button", { name: "Retry review" }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Review stopped safely.")).toBeVisible();

    const retryStreamConnected = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/reviews/${job.id}/events`) &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Retry review" }).click();
    await retryStreamConnected;
    await expect(page.getByText("QUEUED", { exact: true })).toBeVisible();

    await database.query(
      `UPDATE review_steps
        SET state = 'SUCCEEDED',
            output_hash = COALESCE(output_hash, $2),
            finished_at = now()
      WHERE job_id = $1`,
      [job.id, "c".repeat(64)],
    );
    const proposalSummary = `Browser live proposal ${Date.now()}`;
    await database.query(
      `INSERT INTO review_proposals (
       id, job_id, input_revision_id, summary, findings, proposal_hash
     ) VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)`,
      [
        randomUUID(),
        job.id,
        job.input_revision_id,
        proposalSummary,
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
    await database.query(
      `UPDATE review_jobs
        SET state = 'SUCCEEDED',
            finished_at = now(),
            lane_owner = false,
            retry_not_before = NULL,
            failure_code = NULL,
            claim_token = NULL,
            lease_expires_at = NULL
      WHERE id = $1`,
      [job.id],
    );
    await expect(page.locator(".workspacePage > .srOnly")).toContainText(
      "Review complete.",
      { timeout: 10_000 },
    );
    await expect(page.getByText("No suggested changes")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByText("View overall review rationale").click();
    await expect(page.getByText(proposalSummary)).toBeVisible();

    const cancellationStream = page.waitForResponse(
      (response) =>
        response.url().includes("/api/reviews/") &&
        response.url().endsWith("/events") &&
        response.status() === 200 &&
        response.url() !== streamResponse.url(),
    );
    await page.getByRole("button", { name: "Run agent review" }).click();
    await cancellationStream;
    await page.getByRole("button", { name: "Cancel review" }).click();
    await expect(
      page.getByRole("button", { name: "Run agent review" }),
    ).toBeVisible();
    await expect(page.getByText("Review cancelled.")).toBeVisible();
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page).toHaveURL("http://localhost:3015/");
  } finally {
    await cleanupBrowserFixture(browserCheckout.id);
  }
});

test("restored publication explains bounded live-verification evidence", async ({
  page,
}) => {
  const candidate = await database.query<{ id: string; slug: string }>(
    `SELECT situation.id, situation.slug
       FROM situations situation
      WHERE NOT EXISTS (
              SELECT 1
                FROM situation_checkouts checkout
               WHERE checkout.situation_id = situation.id
                 AND checkout.released_at IS NULL
            )
      ORDER BY situation.slug
      LIMIT 1`,
  );
  const situation = candidate.rows[0];
  if (!situation)
    throw new Error("Browser publication fixture situation is unavailable.");

  await signIn(page);
  await page
    .locator("article.inventoryRow")
    .filter({ hasText: situation.slug })
    .getByRole("button", { name: "Check out" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/situations/${situation.slug}$`, "u"),
  );

  const workspace = await database.query<{
    checkout_id: string;
    checkout_fence: string;
    revision_id: string;
    bundle_hash: string;
  }>(
    `SELECT checkout.id AS checkout_id,
            checkout.fence::text AS checkout_fence,
            revision.id AS revision_id,
            revision.bundle_hash
       FROM situation_checkouts checkout
       JOIN drafts draft ON draft.id = checkout.draft_id
       JOIN LATERAL (
         SELECT candidate.*
           FROM draft_revisions candidate
          WHERE candidate.draft_id = draft.id
          ORDER BY candidate.revision DESC
          LIMIT 1
       ) revision ON true
      WHERE checkout.situation_id = $1
        AND checkout.released_at IS NULL`,
    [situation.id],
  );
  const active = workspace.rows[0];
  if (!active) throw new Error("Browser publication checkout is unavailable.");

  const jobId = randomUUID();
  const recoveryJobId = randomUUID();
  try {
    await database.query("BEGIN");
    try {
      await database.query(
        `INSERT INTO publication_jobs (
         id, publication_id, situation_id, target_revision_id, checkout_id,
         checkout_fence, source_kind, state, target_bundle_hash,
         base_bundle_hash, observed_release_id, leadership_release_id,
         leadership_manifest_hash, previous_release_id, started_at,
         finished_at, failure_code
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'MANUAL', 'RESTORED', $7, $7, $8, $8,
         $9, $10, now() - interval '1 minute', now(),
         'RUNTIME_HEALTH_UNAVAILABLE_RESTORED'
       )`,
        [
          jobId,
          randomUUID(),
          situation.id,
          active.revision_id,
          active.checkout_id,
          active.checkout_fence,
          active.bundle_hash,
          randomUUID(),
          "a".repeat(64),
          randomUUID(),
        ],
      );
      const events = [
        ["REQUESTED", {}],
        ["POINTER_OBSERVED", {}],
        ["SNAPSHOT_BUILT", {}],
        ["VALIDATED", {}],
        ["POINTER_ADVANCED", {}],
        [
          "RESTORE_STARTED",
          {
            reason: "RUNTIME_HEALTH_UNAVAILABLE",
            failureDetail: {
              schemaVersion: "publication-failure-detail-v1",
              phase: "RUNTIME_IDENTITY",
              source: "LEADERSHIP_CONTENT_HEALTH",
              reason: "HTTP_STATUS",
              attempts: 24,
              elapsedMs: 11_750,
              lastHttpStatus: 503,
              lastObservedReleaseId: null,
              lastObservedManifestHash: null,
            },
            rawError: "private publisher diagnostic",
          },
        ],
        ["RESTORED", {}],
      ] as const;
      for (const [index, [kind, payload]] of events.entries())
        await database.query(
          `INSERT INTO publication_events (id, job_id, sequence, kind, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [randomUUID(), jobId, index + 1, kind, JSON.stringify(payload)],
        );
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }

    await page.goto(`/situations/${situation.slug}?tab=review`);
    const outcome = page
      .getByRole("alert")
      .filter({ hasText: "Previous version restored" });
    await expect(outcome).toContainText("Previous version restored");
    await expect(outcome).toContainText(
      "Leadership content health returned HTTP 503 after 24 checks",
    );
    await outcome.getByText("Why verification failed").click();
    await expect(outcome).toContainText(
      "The live content health check returned HTTP 503",
    );
    await expect(outcome).toContainText("11.8 seconds");
    await expect(outcome).toContainText(
      "No usable release identity was returned.",
    );
    await expect(outcome).not.toContainText("private publisher diagnostic");
    await expectNoCriticalAccessibilityViolations(page);
    await expectNoPageOverflow(page);

    await database.query("BEGIN");
    try {
      await database.query(
        `INSERT INTO publication_jobs (
         id, publication_id, situation_id, target_revision_id, checkout_id,
         checkout_fence, source_kind, state, target_bundle_hash,
         base_bundle_hash, observed_release_id, leadership_release_id,
         leadership_manifest_hash, previous_release_id, started_at,
         failure_code, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'MANUAL', 'RECOVERY_REQUIRED', $7, $7,
         $8, $8, $9, $10, now() - interval '1 minute',
         'AUTOMATIC_RESTORATION_FAILED', clock_timestamp() + interval '1 second'
       )`,
        [
          recoveryJobId,
          randomUUID(),
          situation.id,
          active.revision_id,
          active.checkout_id,
          active.checkout_fence,
          active.bundle_hash,
          randomUUID(),
          "b".repeat(64),
          randomUUID(),
        ],
      );
      const recoveryEvents = [
        ["REQUESTED", {}],
        ["POINTER_OBSERVED", {}],
        ["SNAPSHOT_BUILT", {}],
        ["VALIDATED", {}],
        ["POINTER_ADVANCED", {}],
        [
          "RESTORE_STARTED",
          {
            failureDetail: {
              schemaVersion: "publication-failure-detail-v1",
              phase: "RUNTIME_IDENTITY",
              source: "LEADERSHIP_CONTENT_HEALTH",
              reason: "HTTP_STATUS",
              attempts: 24,
              elapsedMs: 11_750,
              lastHttpStatus: 503,
              lastObservedReleaseId: null,
              lastObservedManifestHash: null,
            },
          },
        ],
        [
          "RECOVERY_REQUIRED",
          {
            failureDetail: {
              schemaVersion: "publication-failure-detail-v1",
              phase: "RUNTIME_IDENTITY",
              source: "LEADERSHIP_CONTENT_HEALTH",
              reason: "HTTP_STATUS",
              attempts: 24,
              elapsedMs: 11_750,
              lastHttpStatus: 503,
              lastObservedReleaseId: null,
              lastObservedManifestHash: null,
            },
            recoveryFailureDetail: {
              schemaVersion: "publication-failure-detail-v1",
              phase: "RUNTIME_IDENTITY",
              source: "LEADERSHIP_CONTENT_HEALTH",
              reason: "IDENTITY_MISMATCH",
              attempts: 8,
              elapsedMs: 4_250,
              lastHttpStatus: 200,
              lastObservedReleaseId: randomUUID(),
              lastObservedManifestHash: "c".repeat(64),
            },
            rawError: "private recovery diagnostic",
          },
        ],
      ] as const;
      for (const [index, [kind, payload]] of recoveryEvents.entries())
        await database.query(
          `INSERT INTO publication_events (id, job_id, sequence, kind, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            randomUUID(),
            recoveryJobId,
            index + 1,
            kind,
            JSON.stringify(payload),
          ],
        );
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }

    await page.reload();
    const recoveryOutcome = page
      .getByRole("alert")
      .filter({ hasText: "Publication needs attention" });
    await expect(recoveryOutcome).toContainText(
      "Automatic recovery could not be verified",
    );
    await recoveryOutcome.getByText("Why live verification failed").click();
    await recoveryOutcome.getByText("Why automatic recovery failed").click();
    await expect(recoveryOutcome).toContainText(
      "Leadership's current live release identity is not verified",
    );
    await expect(recoveryOutcome).toContainText(
      "An administrator must restore and verify a known release",
    );
    await expect(recoveryOutcome).not.toContainText(
      "The previous verified version is still live",
    );
    await expect(recoveryOutcome).not.toContainText(
      "private recovery diagnostic",
    );
    await expect(page.getByRole("button", { name: "Check in" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Run agent review" }),
    ).toBeDisabled();
    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(page.getByLabel("Title")).toBeDisabled();
    await expect(
      page.getByText("Publication recovery required."),
    ).toBeVisible();
    await expectNoCriticalAccessibilityViolations(page);
    await expectNoPageOverflow(page);

    await page.goto("/");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Studio publication recovery is required." }),
    ).toBeVisible();
    await expect(
      page.getByText("New situation", { exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    const availableCheckoutButtons = page.getByRole("button", {
      name: "Check out",
    });
    expect(await availableCheckoutButtons.count()).toBeGreaterThan(0);
    await expect(availableCheckoutButtons.first()).toBeDisabled();
    await expectNoCriticalAccessibilityViolations(page);
    await expectNoPageOverflow(page);

    await page.goto(`/situations/${situation.slug}?tab=review`);

    await database.query("BEGIN");
    try {
      await database.query("DELETE FROM publication_events WHERE job_id = $1", [
        recoveryJobId,
      ]);
      await database.query("DELETE FROM publication_jobs WHERE id = $1", [
        recoveryJobId,
      ]);
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
    await page.reload();

    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page).toHaveURL("http://localhost:3015/");
  } finally {
    await cleanupBrowserFixture(active.checkout_id, [jobId, recoveryJobId]);
  }
});

test("throttles indistinguishable invalid logins", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1280",
    "Run the security mutation once.",
  );
  await database.query("DELETE FROM login_throttles");
  await page.goto("/");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByLabel("Username").fill("unknown-account");
    await page.getByLabel("Password").fill("incorrect-password-value");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "That username and password did not match.",
    );
  }
  await page.getByLabel("Username").fill("unknown-account");
  await page.getByLabel("Password").fill("incorrect-password-value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in is temporarily paused. Try again in 15 minutes.",
  );
  const blocked = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM login_throttles WHERE blocked_until > now()",
  );
  expect(Number(blocked.rows[0]?.count)).toBe(2);
  await database.query("DELETE FROM login_throttles");
});

test("deactivation revokes an editor session and admin-only navigation", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1280",
    "Run the account mutation once.",
  );
  const suffix = Date.now().toString(36);
  const username = `browser-editor-${suffix}`;
  const password = `browser-editor-password-${suffix}`;
  await signIn(page, "/operations");
  await page.getByLabel("Username").last().fill(username);
  await page.getByLabel("Display name").fill("Browser editor");
  await page.getByLabel("Initial password").fill(password);
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText(`@${username}`)).toBeVisible();

  const editorContext = await browser.newContext();
  const editorPage = await editorContext.newPage();
  try {
    await signIn(editorPage, "/", username, password);
    await expect(
      editorPage.getByRole("link", { name: "Operations" }),
    ).toHaveCount(0);
    await editorPage.goto("/operations");
    await expect(editorPage).toHaveURL("http://localhost:3015/");

    const userRow = page
      .locator(".userList article")
      .filter({ hasText: username });
    await userRow.getByRole("button", { name: "Deactivate" }).click();
    await expect(
      page
        .locator(".userList article")
        .filter({ hasText: username })
        .getByRole("button", { name: "Reactivate" }),
    ).toBeVisible();
    await editorPage.goto("/");
    await expect(editorPage).toHaveURL(/\/login/u);
    const revoked = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sessions session
         JOIN users app_user ON app_user.id = session.user_id
        WHERE app_user.username = $1
          AND session.revoked_reason = 'USER_DEACTIVATED'`,
      [username],
    );
    expect(Number(revoked.rows[0]?.count)).toBeGreaterThan(0);
  } finally {
    await editorContext.close();
  }
});
