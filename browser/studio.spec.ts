import { expect, test } from "@playwright/test";

test("authenticated inventory exposes all imported situations and core navigation", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("studio-admin");
  await page.getByLabel("Password").fill("Studio-Test-Only-Password-2026!");
  await page.getByRole("button", { name: "Enter Situation Studio" }).click();
  await expect(page).toHaveURL("/");
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
  await page.goto("/login");
  await page.getByLabel("Username").fill("studio-admin");
  await page.getByLabel("Password").fill("Studio-Test-Only-Password-2026!");
  await page.getByRole("button", { name: "Enter Situation Studio" }).click();
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
  const suffix = testInfo.project.name.includes("mobile")
    ? "mobile"
    : "desktop";
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
