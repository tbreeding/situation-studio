import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";

export function createDatabaseClient(databaseUrl: string, max = 8) {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    max,
  });
  return new PrismaClient({ adapter });
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;
export {
  Prisma,
  type User,
  type Situation,
  type Draft,
  type SituationCheckout,
} from "../generated/client";
