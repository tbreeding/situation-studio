import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { startLeadershipContractServer } from "./support/leadership-contract-server";
import { seedDatabaseCandidateFixture } from "./support/database-candidate-fixture";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function secret() {
  return randomBytes(32).toString("hex");
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a browser-test port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0)));
  });
  if (code !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${code}.`);
}

function start(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  const output: string[] = [];
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => {
    output.push(chunk.toString("utf8"));
    if (output.length > 80) output.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, output };
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const timedOut = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([exited, timedOut]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function waitForHttp(
  url: string,
  process: { child: ChildProcess; output: string[] },
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null)
      throw new Error(
        `Studio exited before becoming ready.\n${process.output.join("")}`,
      );
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Studio did not become ready.\n${process.output.join("")}`);
}

async function main() {
  const databaseName = `situation_studio_migration_test_playwright_${randomUUID().replaceAll("-", "")}`;
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase(databaseName)
    .withUsername("studio_test_owner")
    .withPassword(secret())
    .start();

  let gitStudio: ReturnType<typeof start> | undefined;
  let databaseStudio: ReturnType<typeof start> | undefined;
  let leadership:
    Awaited<ReturnType<typeof startLeadershipContractServer>> | undefined;

  try {
    const databaseUrl = container
      .getConnectionUri()
      .replace(/^postgres:\/\//u, "postgresql://");
    const baseEnvironment = { ...process.env, DATABASE_URL: databaseUrl };
    await run("pnpm", ["db:migrate:deploy"], baseEnvironment);

    const roles = new Client({ connectionString: databaseUrl });
    await roles.connect();
    try {
      for (const role of [
        "situation_studio_web",
        "situation_studio_ai",
        "situation_studio_validator",
        "situation_studio_publisher",
        "situation_studio_materializer",
        "situation_studio_operations",
        "leadership_content_reader",
      ])
        await roles.query(`CREATE ROLE ${role} NOLOGIN`);
    } finally {
      await roles.end();
    }

    const psql =
      process.env.PSQL_BIN ??
      (process.platform === "darwin"
        ? "/opt/homebrew/opt/libpq/bin/psql"
        : "psql");
    await run(
      psql,
      [
        "-h",
        container.getHost(),
        "-p",
        String(container.getPort()),
        "-U",
        container.getUsername(),
        "-d",
        container.getDatabase(),
        "-f",
        path.join(projectRoot, "ops/grant-database-publication-privileges.sql"),
      ],
      { ...baseEnvironment, PGPASSWORD: container.getPassword() },
    );
    await run(
      "pnpm",
      ["tsx", "packages/testing/src/seed-legacy-database-bootstrap.ts"],
      baseEnvironment,
    );
    await run("pnpm", ["bootstrap:database-publication:apply"], {
      ...baseEnvironment,
      DATABASE_PUBLICATION_BOOTSTRAP_TARGET: "leadership-production",
    });
    await run(
      "pnpm",
      ["tsx", "packages/testing/src/seed-browser-workspace.ts"],
      baseEnvironment,
    );

    const gitPort = await freePort();
    const databasePort = await freePort();
    const leadershipPort = await freePort();
    const gitOrigin = `http://127.0.0.1:${gitPort}`;
    const databaseOrigin = `http://127.0.0.1:${databasePort}`;
    const leadershipOrigin = `http://127.0.0.1:${leadershipPort}`;
    const exchangeSecret = secret();
    const attestationSecret = secret();
    const attestationKeyId = "leadership-contract-e2e-v1";
    const audience = "https://leadership.contract.test";
    const applicationSecrets = {
      SESSION_SECRET: secret(),
      CSRF_SECRET: secret(),
      THROTTLE_SECRET: secret(),
      LEADERSHIP_CANDIDATE_EXCHANGE_SECRET: exchangeSecret,
      LEADERSHIP_ATTESTATION_SECRET: attestationSecret,
      LEADERSHIP_ATTESTATION_KEY_ID: attestationKeyId,
      LEADERSHIP_CANDIDATE_AUDIENCE: audience,
      LEADERSHIP_CANDIDATE_ORIGIN: leadershipOrigin,
      LEADERSHIP_REPO_PATH: path.resolve(projectRoot, "../leadership"),
    };
    await run("pnpm", ["build"], {
      ...baseEnvironment,
      ...applicationSecrets,
      SITUATION_STUDIO_ORIGIN: gitOrigin,
      SITUATION_STUDIO_HOST: new URL(gitOrigin).host,
      PROVIDER_EXECUTION_MODE: "fake",
      PUBLICATION_BACKEND: "git",
    });

    leadership = await startLeadershipContractServer({
      port: leadershipPort,
      studioOrigin: databaseOrigin,
      databaseUrl,
      exchangeSecret,
      attestationSecret,
      attestationKeyId,
      audience,
    });
    gitStudio = start(
      "pnpm",
      [
        "--filter",
        "@situation-studio/web",
        "exec",
        "next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(gitPort),
      ],
      {
        ...baseEnvironment,
        ...applicationSecrets,
        SITUATION_STUDIO_ORIGIN: gitOrigin,
        SITUATION_STUDIO_HOST: new URL(gitOrigin).host,
        PROVIDER_EXECUTION_MODE: "fake",
        PUBLICATION_BACKEND: "git",
      },
    );
    databaseStudio = start(
      "pnpm",
      [
        "--filter",
        "@situation-studio/web",
        "exec",
        "next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(databasePort),
      ],
      {
        ...baseEnvironment,
        ...applicationSecrets,
        SITUATION_STUDIO_ORIGIN: databaseOrigin,
        SITUATION_STUDIO_HOST: new URL(databaseOrigin).host,
        PROVIDER_EXECUTION_MODE: "disabled",
        PUBLICATION_BACKEND: "database",
      },
    );
    await Promise.all([
      waitForHttp(`${gitOrigin}/health/live`, gitStudio),
      waitForHttp(`${databaseOrigin}/health/live`, databaseStudio),
    ]);

    const playwrightEnvironment = {
      ...baseEnvironment,
      PLAYWRIGHT_TESTCONTAINERS: "1",
      PLAYWRIGHT_GIT_BASE_URL: gitOrigin,
      PLAYWRIGHT_DATABASE_BASE_URL: databaseOrigin,
      PLAYWRIGHT_LEADERSHIP_ORIGIN: leadershipOrigin,
      PLAYWRIGHT_ATTESTATION_SECRET: attestationSecret,
      PLAYWRIGHT_ATTESTATION_KEY_ID: attestationKeyId,
    };
    const matrixArguments = [
      "exec",
      "playwright",
      "test",
      "--project=desktop-1280",
      "--project=desktop-1440",
      "--project=mobile-chromium",
    ];
    if (process.env.PLAYWRIGHT_GREP)
      matrixArguments.push("--grep", process.env.PLAYWRIGHT_GREP);
    if (process.env.PLAYWRIGHT_CANDIDATE_ONLY !== "1") {
      try {
        await run("pnpm", matrixArguments, playwrightEnvironment);
      } catch (error) {
        process.stderr.write(
          `\nGit-mode Studio server output:\n${gitStudio.output.join("")}\n`,
        );
        throw error;
      }
    }
    if (process.env.PLAYWRIGHT_MATRIX_ONLY !== "1") {
      await seedDatabaseCandidateFixture(databaseUrl);
      try {
        await run(
          "pnpm",
          ["exec", "playwright", "test", "--project=private-candidate-handoff"],
          playwrightEnvironment,
        );
      } catch (error) {
        process.stderr.write(
          `\nDatabase-mode Studio server output:\n${databaseStudio.output.join("")}\n`,
        );
        throw error;
      }
    }
  } finally {
    await Promise.all([stop(gitStudio?.child), stop(databaseStudio?.child)]);
    await leadership?.close();
    await container.stop();
  }
}

void main();
