import {
  createDatabaseClient,
  type DatabaseClient,
} from "@situation-studio/db";
import { environment } from "@/server/environment";

const globalDatabase = globalThis as typeof globalThis & {
  __situationStudioDatabase?: DatabaseClient;
};

export function database(): DatabaseClient {
  globalDatabase.__situationStudioDatabase ??= createDatabaseClient(
    environment().STUDIO_DATABASE_URL,
  );
  return globalDatabase.__situationStudioDatabase;
}
