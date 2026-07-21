import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Pool } from "pg";
import { createDatabaseClient } from "../../packages/db/src/client";
import { sha256 } from "../../packages/domain/src/index";
import { leadershipObservationSignedBody } from "../../apps/web/src/lib/leadership-observation";
import { candidateHandoffSignature } from "../../apps/web/src/server/publication/candidate-handoff";
import { processDatabasePublication } from "../../apps/publisher/src/database-service";

type CandidateSession = {
  publicationRequestId: string;
  reviewerId: string;
  returnTo: string;
  cookieTokenHash: string;
};

function html(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function responseHeaders(contentType: string) {
  return {
    "cache-control": "no-store, private",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
}

function cookie(request: IncomingMessage, name: string) {
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  value: string,
) {
  response.writeHead(status, responseHeaders(contentType));
  response.end(value);
}

export async function startLeadershipContractServer(input: {
  port: number;
  studioOrigin: string;
  databaseUrl: string;
  exchangeSecret: string;
  attestationSecret: string;
  attestationKeyId: string;
  audience: string;
}) {
  const readerUrl = new URL(input.databaseUrl);
  readerUrl.searchParams.set("options", "-c role=leadership_content_reader");
  const reader = new Pool({ connectionString: readerUrl.toString(), max: 2 });
  const materializerUrl = new URL(input.databaseUrl);
  materializerUrl.searchParams.set(
    "options",
    "-c role=situation_studio_materializer",
  );
  const materializer = createDatabaseClient(materializerUrl.toString(), 2);
  const sessions = new Map<string, CandidateSession>();
  const observedRequests = new Set<string>();
  const state = {
    bootstrapAttempts: 0,
    completeAttempts: 0,
    crossSitePostAttempts: 0,
    exchangeAttempts: 0,
    lastReturnTo: null as string | null,
    replayStatus: null as number | null,
    observations: 0,
  };
  await reader.query("SELECT 1");

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${input.port}`);
      if (request.method === "GET" && url.pathname === "/health/live") {
        send(response, 200, "application/json", '{"status":"live"}');
        return;
      }
      if (request.method === "GET" && url.pathname === "/__test/state") {
        send(response, 200, "application/json", JSON.stringify(state));
        return;
      }
      if (request.method === "POST" && url.pathname === "/candidate/exchange") {
        state.crossSitePostAttempts += 1;
        send(response, 403, "application/json", '{"error":"Access denied."}');
        return;
      }
      if (request.method === "GET" && url.pathname === "/candidate/bootstrap") {
        state.bootstrapAttempts += 1;
        const callbackValue = url.searchParams.get("callback") ?? "";
        const stateValue = url.searchParams.get("state") ?? "";
        const callback = new URL(callbackValue);
        if (
          callback.origin !== input.studioOrigin ||
          callback.pathname !== "/api/candidates/handoff" ||
          callback.searchParams.get("state") !== stateValue ||
          !/^[a-f0-9]{64}$/u.test(stateValue)
        ) {
          send(response, 400, "text/plain; charset=utf-8", "Invalid bootstrap");
          return;
        }
        const requestId = callback.searchParams.get("requestId") ?? "";
        const requestKind = callback.searchParams.get("requestKind") ?? "";
        const situationSlug = callback.searchParams.get("situationSlug") ?? "";
        if (
          !/^[0-9a-f-]{36}$/u.test(requestId) ||
          !["publication", "rollback"].includes(requestKind) ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(situationSlug)
        ) {
          send(response, 400, "text/plain; charset=utf-8", "Invalid callback");
          return;
        }
        const handoffId = randomUUID();
        const verifier = randomBytes(32).toString("hex");
        const proof = {
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          handoffId,
          requestId,
          requestKind: requestKind as "publication" | "rollback",
          situationSlug,
          state: stateValue,
          verifierHash: sha256(verifier),
        };
        callback.searchParams.set("expiresAt", proof.expiresAt);
        callback.searchParams.set("handoffId", proof.handoffId);
        callback.searchParams.set("verifierHash", proof.verifierHash);
        callback.searchParams.set(
          "signature",
          candidateHandoffSignature(input.exchangeSecret, proof),
        );
        response.writeHead(303, {
          ...responseHeaders("text/plain; charset=utf-8"),
          location: callback.toString(),
          "set-cookie": `leadership_handoff_e2e=${handoffId}.${verifier}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`,
        });
        response.end("Continue");
        return;
      }
      if (request.method === "GET" && url.pathname === "/candidate/complete") {
        state.completeAttempts += 1;
        const handoffCookie = cookie(request, "leadership_handoff_e2e") ?? "";
        const [cookieHandoffId, verifier] = handoffCookie.split(".");
        const handoffId = url.searchParams.get("handoffId") ?? "";
        const returnTo = url.searchParams.get("returnTo") ?? "";
        state.lastReturnTo = returnTo;
        if (
          cookieHandoffId !== handoffId ||
          !verifier ||
          !/^[a-f0-9]{64}$/u.test(verifier) ||
          !/^\/situations\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(returnTo)
        ) {
          send(response, 404, "text/plain; charset=utf-8", "Invalid handoff");
          return;
        }
        state.exchangeAttempts += 1;
        const exchange = await fetch(
          `${input.studioOrigin}/api/candidates/exchange-handoff`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.exchangeSecret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ handoffId, verifier }),
          },
        );
        const result = (await exchange.json().catch(() => null)) as {
          audience?: string;
          cookieToken?: string;
          publicationRequestId?: string;
          reviewerId?: string;
        } | null;
        if (
          !exchange.ok ||
          !result?.cookieToken ||
          !/^[a-f0-9]{64}$/u.test(result.cookieToken) ||
          !result?.publicationRequestId ||
          !result.reviewerId ||
          result.audience !== input.audience
        ) {
          send(response, 403, "text/plain; charset=utf-8", "Exchange denied");
          return;
        }
        const replay = await fetch(
          `${input.studioOrigin}/api/candidates/exchange-handoff`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.exchangeSecret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ handoffId, verifier }),
          },
        );
        state.replayStatus = replay.status;
        const sessionId = randomUUID();
        sessions.set(sessionId, {
          publicationRequestId: result.publicationRequestId,
          reviewerId: result.reviewerId,
          returnTo,
          cookieTokenHash: sha256(result.cookieToken),
        });
        response.writeHead(303, {
          ...responseHeaders("text/plain; charset=utf-8"),
          location: "/candidate/continue",
          "set-cookie": [
            `leadership_candidate_e2e=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`,
            "leadership_handoff_e2e=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
          ],
        });
        response.end("Continue");
        return;
      }

      const sessionId = cookie(request, "leadership_candidate_e2e");
      const candidateSession = sessionId ? sessions.get(sessionId) : null;
      if (request.method === "GET" && url.pathname === "/candidate/continue") {
        if (!candidateSession) {
          send(
            response,
            403,
            "text/plain; charset=utf-8",
            "Session unavailable",
          );
          return;
        }
        send(
          response,
          200,
          "text/html; charset=utf-8",
          `<!doctype html><html><body><main><h1>Private candidate access ready</h1><p>The one-time exchange is complete.</p><a href="${html(candidateSession.returnTo)}">Continue to private candidate</a></main></body></html>`,
        );
        return;
      }

      const situationMatch = /^\/situations\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(
        url.pathname,
      );
      if (request.method === "GET" && situationMatch) {
        const officialResult = await reader.query<{
          snapshot_id: string;
          snapshot_hash: string;
        }>(
          `SELECT snapshot_id::text,
                  trim(snapshot_hash)::text AS snapshot_hash
           FROM leadership_read_official_snapshot_v2($1::text)
           LIMIT 1`,
          ["leadership-production"],
        );
        const official = officialResult.rows[0];
        if (!official) throw new Error("official snapshot is unavailable");
        if (!candidateSession) {
          send(
            response,
            200,
            "text/html; charset=utf-8",
            `<!doctype html><html><body><main><h1>Official Leadership guidance</h1><p data-testid="official-hash">${html(official.snapshot_hash)}</p></main></body></html>`,
          );
          return;
        }
        const candidateResult = await reader.query<{
          snapshot_id: string;
          snapshot_hash: string;
        }>(
          `SELECT snapshot_id::text,
                  trim(snapshot_hash)::text AS snapshot_hash
           FROM leadership_read_candidate_snapshot_v2(
             $1::text,
             $2::text,
             $3::uuid,
             $4::text
           )
           WHERE logical_id = $5
           LIMIT 1`,
          [
            "leadership-production",
            candidateSession.cookieTokenHash,
            candidateSession.reviewerId,
            input.audience,
            `situation:${situationMatch[1]}`,
          ],
        );
        const candidate = candidateResult.rows[0];
        if (!candidate) throw new Error("candidate snapshot is unavailable");

        if (!observedRequests.has(candidateSession.publicationRequestId)) {
          const unsigned = {
            snapshotId: candidate.snapshot_id,
            snapshotHash: candidate.snapshot_hash,
            observationKind: "CANDIDATE" as const,
            cacheSource: "DATABASE" as const,
            healthResult: "HEALTHY" as const,
            applicationReleaseIdentity: "leadership-contract-e2e",
            routeProbeHash: sha256(
              `route:${situationMatch[1]}:${candidate.snapshot_hash}`,
            ),
            attestationKeyId: input.attestationKeyId,
            observedAt: new Date().toISOString(),
          };
          const receiptDigest = createHmac("sha256", input.attestationSecret)
            .update(
              leadershipObservationSignedBody(
                candidateSession.publicationRequestId,
                unsigned,
              ),
            )
            .digest("hex");
          const observation = await fetch(
            `${input.studioOrigin}/api/publications/${candidateSession.publicationRequestId}/observations`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...unsigned, receiptDigest }),
            },
          );
          if (!observation.ok)
            throw new Error(
              `candidate observation was rejected with ${observation.status}`,
            );
          const advanced = await processDatabasePublication(
            materializer,
            candidateSession.publicationRequestId,
          );
          if (advanced.state !== "AWAITING_CONFIRMATION")
            throw new Error(
              `candidate observation stopped at ${advanced.state}`,
            );
          observedRequests.add(candidateSession.publicationRequestId);
          state.observations += 1;
        }
        send(
          response,
          200,
          "text/html; charset=utf-8",
          `<!doctype html><html><body><main><h1>Private Leadership candidate</h1><p data-testid="candidate-hash">${html(candidate.snapshot_hash)}</p><p>Official remains <span data-testid="official-hash">${html(official.snapshot_hash)}</span></p><a href="${html(input.studioOrigin)}${html(candidateSession.returnTo)}">Return to Situation Studio</a></main></body></html>`,
        );
        return;
      }

      send(response, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      send(
        response,
        500,
        "text/plain; charset=utf-8",
        error instanceof Error ? error.message : "Contract server failed",
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, "127.0.0.1", () => resolve());
  });

  return {
    origin: `http://127.0.0.1:${input.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all([reader.end(), materializer.$disconnect()]);
    },
  };
}
