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
