import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url:
      process.env.STUDIO_DATABASE_URL ??
      "postgresql://invalid@127.0.0.1:5432/situation_studio",
  },
});
