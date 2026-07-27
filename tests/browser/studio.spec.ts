import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const databaseUrl =
  process.env.STUDIO_BROWSER_DATABASE_URL ?? process.env.STUDIO_DATABASE_URL;
const adminPassword = process.env.STUDIO_BROWSER_ADMIN_PASSWORD;
if (!databaseUrl || !adminPassword)
  throw new Error(
    "Browser tests require STUDIO_BROWSER_DATABASE_URL and STUDIO_BROWSER_ADMIN_PASSWORD.",
  );

const database = new Client({ connectionString: databaseUrl });

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

test.afterAll(async () => {
  await database.end();
});

test.beforeAll(async () => {
  await database.connect();
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
    "1 of 22 stages complete",
  );
  await expect(
    page.getByText("1 of 22 stages complete", { exact: true }),
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
  await expect(retryStatus).toContainText("Temporary provider interruption");
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
  await expect(page.getByRole("button", { name: "Retry review" })).toBeVisible({
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
            retry_not_before = NULL,
            failure_code = NULL,
            claim_token = NULL,
            lease_expires_at = NULL
      WHERE id = $1`,
    [job.id],
  );
  await expect(page.getByText("Review complete.", { exact: true })).toBeVisible(
    {
      timeout: 10_000,
    },
  );
  await expect(page.getByText(proposalSummary)).toBeVisible({
    timeout: 10_000,
  });

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
