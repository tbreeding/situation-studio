import path from "node:path";
import { createDatabaseClient } from "@situation-studio/db";
import { importLegacyBaseline } from "../src/server/setup/baseline";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(
  process.env.LEADERSHIP_REPO_PATH ?? path.join(studioRoot, "../leadership"),
);
const database = createDatabaseClient(databaseUrl, 2);
try {
  const result = await importLegacyBaseline(
    database,
    studioRoot,
    leadershipRoot,
  );
  process.stdout.write(
    `${result.imported ? "Imported" : "Already imported"} ${result.situations} situations and ${result.artifacts} artifacts.\n`,
  );
} finally {
  await database.$disconnect();
}
