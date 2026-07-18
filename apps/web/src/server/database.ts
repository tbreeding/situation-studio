import { createDatabaseClient } from "@situation-studio/db";
import { environment } from "@/server/environment";

const globalDatabase = globalThis as unknown as {
  studioDatabase?: ReturnType<typeof createDatabaseClient>;
};

export function database() {
  globalDatabase.studioDatabase ??= createDatabaseClient(
    environment().DATABASE_URL,
    8,
  );
  return globalDatabase.studioDatabase;
}
