import { defineConfig, devices } from "@playwright/test";
import { canonicalJson, sha256 } from "@situation-studio/domain";
import {
  leadershipCapabilitySchemaVersion,
  leadershipTypedParityPredicate,
  requiredContentContractIdentity,
  requiredLeadershipFeatures,
  requiredSituationContractIdentity,
} from "@situation-studio/leadership-bridge";

const databaseUrl =
  process.env.STUDIO_BROWSER_DATABASE_URL ?? process.env.STUDIO_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "STUDIO_BROWSER_DATABASE_URL is required. Point it at a migrated, disposable Studio database.",
  );

function compatibleCapabilitiesUrl() {
  const capabilitySet = {
    schemaVersion: leadershipCapabilitySchemaVersion,
    deployment: {
      commit: "d".repeat(40),
      releaseId: "browser-test-runtime",
      archiveSha256: "a".repeat(64),
    },
    contracts: {
      content: requiredContentContractIdentity,
      situation: requiredSituationContractIdentity,
    },
    database: { predicate: leadershipTypedParityPredicate },
    features: [...requiredLeadershipFeatures],
  };
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({
      ...capabilitySet,
      capabilityDigest: sha256(canonicalJson(capabilitySet)),
    }),
  )}`;
}

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3015",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm --filter @situation-studio/web build && env NODE_ENV=test pnpm --filter @situation-studio/web start",
    url: "http://127.0.0.1:3015/health/live",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      STUDIO_DATABASE_URL: databaseUrl,
      SESSION_SECRET: process.env.SESSION_SECRET ?? "s".repeat(32),
      CSRF_SECRET: process.env.CSRF_SECRET ?? "c".repeat(32),
      THROTTLE_SECRET: process.env.THROTTLE_SECRET ?? "t".repeat(32),
      SITUATION_STUDIO_ORIGIN: "http://localhost:3015",
      LEADERSHIP_RUNTIME_CAPABILITIES_URL:
        process.env.LEADERSHIP_RUNTIME_CAPABILITIES_URL ??
        compatibleCapabilitiesUrl(),
    },
  },
  projects: [
    {
      name: "desktop-1280",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "desktop-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-390",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
      },
    },
  ],
});
