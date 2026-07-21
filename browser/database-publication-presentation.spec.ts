import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import {
  browserCandidateFailureReason,
  browserCandidateFixtureKey,
  browserCandidateSituationSlug,
} from "./support/database-candidate-fixture";

const password = "Studio-Test-Only-Password-2026!";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("studio-admin");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Enter Situation Studio" }).click();
  await expect(page).toHaveURL("/");
}

test("a failed private preview renders one terminal truth and one recovery action", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(
    process.env.PLAYWRIGHT_TESTCONTAINERS !== "1" || !databaseUrl,
    "The publication presentation regression requires Testcontainers.",
  );
  if (!databaseUrl) return;

  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1),
  );
  expect(databaseName).toMatch(/^situation_studio_migration_test_playwright_/u);
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  let acquiredCheckoutId: string | null = null;
  try {
    const evidence = await database.query<{
      candidate_publication_request_id: string | null;
      candidate_snapshot_id: string | null;
      error_class: string | null;
      final_confirmed_at: Date | null;
      official_snapshot_id: string | null;
      reason: string | null;
      request_id: string;
      request_state: string;
      publication_state: string;
      terminal_outcome: string | null;
      active_checkouts: string;
    }>(
      `SELECT request.id AS request_id,
              request.state AS request_state,
              request.final_confirmed_at,
              request.error_class,
              request.reconciliation_reason AS reason,
              publication.state AS publication_state,
              publication.terminal_outcome,
              target.official_snapshot_id,
              target.candidate_snapshot_id,
              target.candidate_publication_request_id,
              (SELECT COUNT(*)::text
               FROM situation_checkouts AS checkout
               WHERE checkout.situation_id = bundle.situation_id
                 AND checkout.released_at IS NULL) AS active_checkouts
       FROM publication_requests AS request
       JOIN proposed_bundles AS bundle ON bundle.id = request.bundle_id
       JOIN database_publications AS publication
         ON publication.publication_request_id = request.id
       JOIN publication_targets AS target
         ON target.id = request.publication_target_id
       WHERE request.idempotency_key = $1`,
      [browserCandidateFixtureKey],
    );
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({
      request_state: "FAILED_PREVIEW",
      publication_state: "FAILED_PREVIEW",
      terminal_outcome: "FAILED_BEFORE_CONFIRMATION",
      final_confirmed_at: null,
      error_class: "DATABASE_PUBLICATION_FAILURE",
      reason: browserCandidateFailureReason,
      candidate_snapshot_id: null,
      candidate_publication_request_id: null,
      active_checkouts: "0",
    });
    expect(evidence.rows[0]?.official_snapshot_id).toMatch(/^[0-9a-f-]{36}$/u);

    await login(page);
    await page.goto(`/situations/${browserCandidateSituationSlug}`);

    await expect(page.getByTestId("publication-candidate-status")).toHaveText(
      "Preview failed",
    );
    await expect(page.getByTestId("publication-decision-status")).toHaveText(
      "Private preview failed; public content unchanged",
    );
    await expect(page.getByTestId("leadership-display-status")).toHaveText(
      "Official baseline unchanged",
    );
    await expect(page.getByTestId("leadership-display-detail")).toHaveText(
      "No private candidate is active. The failed attempt did not change public content.",
    );

    const summary = page.locator(".workspaceSummary");
    await expect(summary).toContainText("Official baseline");
    await expect(summary).toContainText("Published");
    await expect(summary).toContainText(
      "Check out this situation to prepare a fresh review against the current official snapshot.",
    );
    await expect(summary).not.toContainText(/preparing|in progress/iu);

    const failureNotice = page
      .locator(".artifactStateNotice.candidate")
      .filter({ hasText: "Private preview failed safely" });
    await expect(failureNotice).toHaveCount(1);
    await expect(failureNotice).toContainText(
      "Public content was unchanged and publisher custody was released.",
    );
    await expect(failureNotice).toContainText(
      `Recorded reason: ${browserCandidateFailureReason}`,
    );
    await expect(failureNotice).toContainText("Failed candidate snapshot");

    const finalPublication = page
      .locator(".lifecycleList li")
      .filter({ hasText: "Final publication" });
    await expect(finalPublication).toContainText(
      "Private preview failed; public content unchanged",
    );
    await expect(finalPublication).not.toContainText(/preparing|in progress/iu);

    await expect(page.locator(".publicationProgress")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Review private candidate" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Confirm and publish/u }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh publication status" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Prepare fresh database review" }),
    ).toHaveCount(0);

    const checkoutButton = page.getByRole("button", {
      name: "Check out for editing",
    });
    await expect(checkoutButton).toBeVisible();
    const [checkoutResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/checkout"),
      ),
      checkoutButton.click(),
    ]);
    expect(checkoutResponse.status()).toBe(200);
    const acquiredCheckout = await database.query<{ id: string }>(
      `SELECT checkout.id
       FROM situation_checkouts AS checkout
       JOIN situations AS situation ON situation.id = checkout.situation_id
       JOIN users AS holder ON holder.id = checkout.holder_user_id
       WHERE situation.slug = $1
         AND holder.username = 'studio-admin'
         AND checkout.custody = 'USER'
         AND checkout.released_at IS NULL`,
      [browserCandidateSituationSlug],
    );
    expect(acquiredCheckout.rows).toHaveLength(1);
    acquiredCheckoutId = acquiredCheckout.rows[0]?.id ?? null;

    await expect(page.getByTestId("publication-candidate-status")).toHaveText(
      "Preview failed",
    );
    await expect(page.getByTestId("leadership-display-status")).toHaveText(
      "Official baseline unchanged",
    );
    await expect(checkoutButton).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Prepare fresh database review" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Prepare exact bundle for my approval",
      }),
    ).toHaveCount(0);
    await expect(summary).not.toContainText(/preparing|in progress/iu);
  } finally {
    if (acquiredCheckoutId) {
      await database.query("BEGIN");
      try {
        await database.query(
          `UPDATE situation_checkouts
           SET released_at = NOW(), release_reason = 'BROWSER_TEST_CLEANUP'
           WHERE id = $1 AND released_at IS NULL`,
          [acquiredCheckoutId],
        );
        await database.query(
          `UPDATE checkout_resources
           SET released_at = NOW()
           WHERE checkout_id = $1 AND released_at IS NULL`,
          [acquiredCheckoutId],
        );
        await database.query("COMMIT");
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      }
    }
    await database.end();
  }
});
