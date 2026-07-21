import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  fullyParallel: false,
  // Every viewport project shares one disposable PostgreSQL fixture database.
  // Keep cross-project mutations from leaking into read-only workspace checks.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3015",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-1280",
      testMatch: "studio.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_GIT_BASE_URL ??
          process.env.PLAYWRIGHT_BASE_URL ??
          "http://127.0.0.1:3015",
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "desktop-1440",
      testMatch: "studio.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_GIT_BASE_URL ??
          process.env.PLAYWRIGHT_BASE_URL ??
          "http://127.0.0.1:3015",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-chromium",
      testMatch: "studio.spec.ts",
      use: {
        ...devices["Pixel 7"],
        baseURL:
          process.env.PLAYWRIGHT_GIT_BASE_URL ??
          process.env.PLAYWRIGHT_BASE_URL ??
          "http://127.0.0.1:3015",
      },
    },
    {
      name: "private-candidate-handoff",
      testMatch: "private-candidate-handoff.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_DATABASE_BASE_URL ??
          process.env.PLAYWRIGHT_BASE_URL ??
          "http://127.0.0.1:3015",
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "database-publication-presentation",
      testMatch: "database-publication-presentation.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.PLAYWRIGHT_DATABASE_BASE_URL ??
          process.env.PLAYWRIGHT_BASE_URL ??
          "http://127.0.0.1:3015",
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
