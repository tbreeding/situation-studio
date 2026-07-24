import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
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
  await expect(page.getByText("Exact source diff")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /History/u })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(reviewTab).toBeFocused();
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
