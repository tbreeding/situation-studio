import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const webRoot = path.join(projectRoot, "apps/web");
const tlsPort = Number(process.env.STUDIO_BROWSER_PORT ?? "3015");
const upstreamPort = Number(process.env.STUDIO_BROWSER_UPSTREAM_PORT ?? "3016");
const certificateRoot = await mkdtemp(
  path.join(os.tmpdir(), "situation-studio-browser-tls-"),
);
const keyPath = path.join(certificateRoot, "localhost-key.pem");
const certificatePath = path.join(certificateRoot, "localhost-cert.pem");

const certificate = spawnSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ],
  { stdio: "ignore" },
);
if (certificate.error || certificate.status !== 0) {
  await rm(certificateRoot, { recursive: true, force: true });
  throw certificate.error ?? new Error("Could not create the local TLS key.");
}

const nextBinary = path.join(webRoot, "node_modules/next/dist/bin/next");
const application = spawn(
  process.execPath,
  [
    nextBinary,
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(upstreamPort),
  ],
  {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  },
);

const server = createServer(
  {
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
  },
  (request, response) => {
    const host = request.headers.host ?? `localhost:${tlsPort}`;
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          host,
          "x-forwarded-host": host,
          "x-forwarded-proto": "https",
        },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent)
        response.writeHead(502, { "content-type": "text/plain" });
      response.end("The local production server is starting.");
    });
    request.pipe(upstream);
  },
);

let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeAllConnections();
  if (application.exitCode === null) application.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => application.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await rm(certificateRoot, { recursive: true, force: true });
  process.exit(exitCode);
}

application.once("error", () => void shutdown(1));
application.once("exit", (code) => {
  if (!shuttingDown) void shutdown(code ?? 1);
});
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(0));

server.listen(tlsPort, "127.0.0.1");
