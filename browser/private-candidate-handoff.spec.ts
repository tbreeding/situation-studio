import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { sha256 } from "../packages/domain/src/index";
import { leadershipObservationSignedBody } from "../apps/web/src/lib/leadership-observation";

const password = "Studio-Test-Only-Password-2026!";
const browserCandidateFixtureKey = "playwright-private-candidate-handoff-v1";
const browserCandidateSituationSlug = "make-bad-attitude-specific";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("studio-admin");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Enter Situation Studio" }).click();
  await expect(page).toHaveURL("/");
}

test("recent reauthentication hands the exact candidate through one same-tab exchange", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const databaseUrl = process.env.DATABASE_URL;
  const leadershipOrigin = process.env.PLAYWRIGHT_LEADERSHIP_ORIGIN;
  const attestationSecret = process.env.PLAYWRIGHT_ATTESTATION_SECRET;
  const attestationKeyId = process.env.PLAYWRIGHT_ATTESTATION_KEY_ID;
  test.skip(
    process.env.PLAYWRIGHT_TESTCONTAINERS !== "1" ||
      !databaseUrl ||
      !leadershipOrigin ||
      !attestationSecret ||
      !attestationKeyId,
    "The private handoff requires its Testcontainers contract environment.",
  );
  if (
    !databaseUrl ||
    !leadershipOrigin ||
    !attestationSecret ||
    !attestationKeyId
  )
    return;

  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  const fixtureRows = await database.query<{
    request_id: string;
    candidate_snapshot_id: string;
    candidate_snapshot_hash: string;
    official_snapshot_id: string;
    official_snapshot_hash: string;
  }>(
    `SELECT request.id AS request_id,
            publication.candidate_snapshot_id,
            request.candidate_content_snapshot_hash AS candidate_snapshot_hash,
            target.official_snapshot_id,
            official.manifest_hash AS official_snapshot_hash
     FROM publication_requests AS request
     JOIN database_publications AS publication
       ON publication.publication_request_id = request.id
     JOIN publication_targets AS target
       ON target.id = request.publication_target_id
     JOIN content_snapshots AS official
       ON official.id = target.official_snapshot_id
     WHERE request.idempotency_key = $1`,
    [browserCandidateFixtureKey],
  );
  const row = fixtureRows.rows[0];
  expect(row).toBeDefined();
  if (!row) return;
  const fixture = {
    requestId: row.request_id,
    candidateSnapshotId: row.candidate_snapshot_id,
    candidateSnapshotHash: row.candidate_snapshot_hash,
    officialSnapshotId: row.official_snapshot_id,
    officialSnapshotHash: row.official_snapshot_hash,
    situationSlug: browserCandidateSituationSlug,
  };
  try {
    const receipt = (input: {
      healthResult: "HEALTHY" | "DEGRADED";
      observedAt: string;
      requestId?: string;
      snapshotId?: string;
      snapshotHash?: string;
      keyId?: string;
    }) => {
      const unsigned = {
        snapshotId: input.snapshotId ?? fixture.candidateSnapshotId,
        snapshotHash: input.snapshotHash ?? fixture.candidateSnapshotHash,
        observationKind: "CANDIDATE" as const,
        cacheSource: "DATABASE" as const,
        healthResult: input.healthResult,
        applicationReleaseIdentity: "negative-boundary-e2e",
        routeProbeHash: sha256(`negative:${input.observedAt}`),
        attestationKeyId: input.keyId ?? attestationKeyId,
        observedAt: input.observedAt,
      };
      return {
        ...unsigned,
        receiptDigest: createHmac("sha256", attestationSecret)
          .update(
            leadershipObservationSignedBody(
              input.requestId ?? fixture.requestId,
              unsigned,
            ),
          )
          .digest("hex"),
      };
    };

    const wrongKey = await request.post(
      `/api/publications/${fixture.requestId}/observations`,
      {
        data: receipt({
          healthResult: "HEALTHY",
          observedAt: new Date().toISOString(),
          keyId: "wrong-attestation-key",
        }),
      },
    );
    expect(wrongKey.status()).toBe(403);
    const stale = await request.post(
      `/api/publications/${fixture.requestId}/observations`,
      {
        data: receipt({
          healthResult: "HEALTHY",
          observedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        }),
      },
    );
    expect(stale.status()).toBe(409);
    const wrongRequestId = randomUUID();
    const wrongRequest = await request.post(
      `/api/publications/${wrongRequestId}/observations`,
      {
        data: receipt({
          healthResult: "HEALTHY",
          observedAt: new Date().toISOString(),
          requestId: wrongRequestId,
        }),
      },
    );
    expect(wrongRequest.status()).toBe(404);
    const wrongSnapshot = await request.post(
      `/api/publications/${fixture.requestId}/observations`,
      {
        data: receipt({
          healthResult: "HEALTHY",
          observedAt: new Date().toISOString(),
          snapshotId: randomUUID(),
        }),
      },
    );
    expect(wrongSnapshot.status()).toBe(409);
    const wrongHash = await request.post(
      `/api/publications/${fixture.requestId}/observations`,
      {
        data: receipt({
          healthResult: "HEALTHY",
          observedAt: new Date().toISOString(),
          snapshotHash: "f".repeat(64),
        }),
      },
    );
    expect(wrongHash.status()).toBe(409);
    const degraded = await request.post(
      `/api/publications/${fixture.requestId}/observations`,
      {
        data: receipt({
          healthResult: "DEGRADED",
          observedAt: new Date().toISOString(),
        }),
      },
    );
    expect(degraded.status()).toBe(201);
    const stateAfterDegraded = await database.query<{ state: string }>(
      "SELECT state FROM publication_requests WHERE id = $1",
      [fixture.requestId],
    );
    expect(stateAfterDegraded.rows[0]?.state).toBe("CANDIDATE_AVAILABLE");

    await login(page);
    await page.goto(`/situations/${fixture.situationSlug}`);
    await database.query(
      `UPDATE sessions
       SET reauthenticated_at = NOW() - INTERVAL '16 minutes'
       WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      ["studio-admin"],
    );
    await expect(
      page.getByRole("heading", {
        name: "Review the private Leadership candidate",
      }),
    ).toBeVisible();

    let popupCount = 0;
    page.on("popup", () => {
      popupCount += 1;
    });
    const authorizationPattern = `**/api/publications/${fixture.requestId}/candidate-authorization`;
    await page.route(
      authorizationPattern,
      async (route) => route.abort("connectionfailed"),
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Review private candidate" })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "could not connect. You are still in Studio" }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/situations/${fixture.situationSlug}$`, "u"),
    );
    expect(popupCount).toBe(0);

    const beforeAuthorization = await database.query(
      "SELECT id FROM candidate_authorizations WHERE publication_request_id = $1",
      [fixture.requestId],
    );
    expect(beforeAuthorization.rows).toHaveLength(0);
    const [blockedAuthorization] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith(
              `/api/publications/${fixture.requestId}/candidate-authorization`,
            ),
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: "Review private candidate" }).click(),
    ]);
    expect(blockedAuthorization.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Confirm your password" }),
    ).toBeVisible();
    expect(popupCount).toBe(0);

    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    const continueToLeadership = page.getByRole("link", {
      name: "Continue securely to Leadership",
    });
    await expect(continueToLeadership).toBeVisible();
    await Promise.all([
      page.waitForURL(`${leadershipOrigin}/candidate/continue`),
      continueToLeadership.click(),
    ]);
    expect(page.url()).not.toContain("token");
    expect(page.url()).not.toBe("about:blank");
    expect(popupCount).toBe(0);
    await expect(
      page.getByRole("heading", { name: "Private candidate access ready" }),
    ).toBeVisible();

    const contractState = await (
      await request.get(`${leadershipOrigin}/__test/state`)
    ).json();
    expect(contractState).toMatchObject({
      bootstrapAttempts: 1,
      completeAttempts: 1,
      crossSitePostAttempts: 0,
      exchangeAttempts: 1,
      lastReturnTo: `/situations/${fixture.situationSlug}`,
      replayStatus: 404,
      observations: 0,
    });
    const authorization = await database.query<{
      exchanged_at: Date | null;
      handoff_id: string | null;
      handoff_verifier_hash: string | null;
      publication_request_id: string;
      snapshot_hash: string;
      revoked_at: Date | null;
    }>(
      `SELECT publication_request_id, snapshot_hash, exchanged_at, revoked_at,
              handoff_id, trim(handoff_verifier_hash) AS handoff_verifier_hash
       FROM candidate_authorizations
       WHERE publication_request_id = $1`,
      [fixture.requestId],
    );
    expect(authorization.rows).toHaveLength(1);
    expect(authorization.rows[0]).toMatchObject({
      publication_request_id: fixture.requestId,
      snapshot_hash: fixture.candidateSnapshotHash,
      revoked_at: null,
    });
    expect(authorization.rows[0]?.exchanged_at).not.toBeNull();
    expect(authorization.rows[0]?.handoff_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(authorization.rows[0]?.handoff_verifier_hash).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    await page
      .getByRole("link", { name: "Continue to private candidate" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Private Leadership candidate" }),
    ).toBeVisible();
    await expect(page.getByTestId("candidate-hash")).toHaveText(
      fixture.candidateSnapshotHash,
    );
    await expect(page.getByTestId("official-hash")).toHaveText(
      fixture.officialSnapshotHash,
    );
    expect(page.url()).not.toContain("token");

    const anonymous = await browser.newContext();
    try {
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(
        `${leadershipOrigin}/situations/${fixture.situationSlug}`,
      );
      await expect(
        anonymousPage.getByRole("heading", {
          name: "Official Leadership guidance",
        }),
      ).toBeVisible();
      await expect(anonymousPage.getByTestId("official-hash")).toHaveText(
        fixture.officialSnapshotHash,
      );
      await expect(anonymousPage.getByTestId("candidate-hash")).toHaveCount(0);
    } finally {
      await anonymous.close();
    }

    await page
      .getByRole("link", { name: "Return to Situation Studio" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Leadership is displaying the private candidate",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Confirm and publish ${fixture.candidateSnapshotHash.slice(0, 8)}`,
      }),
    ).toBeVisible();

    const finalState = await database.query<{
      state: string;
      final_confirmed_at: Date | null;
      official_snapshot_id: string;
      confirmations: string;
    }>(
      `SELECT request.state, request.final_confirmed_at,
              target.official_snapshot_id,
              (SELECT COUNT(*)::text FROM publication_confirmations
               WHERE publication_request_id = request.id) AS confirmations
       FROM publication_requests AS request
       JOIN publication_targets AS target
         ON target.id = request.publication_target_id
       WHERE request.id = $1`,
      [fixture.requestId],
    );
    expect(finalState.rows[0]).toEqual({
      state: "AWAITING_CONFIRMATION",
      final_confirmed_at: null,
      official_snapshot_id: fixture.officialSnapshotId,
      confirmations: "0",
    });
  } finally {
    await database.end();
  }
});
