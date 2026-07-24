CREATE TABLE "process_heartbeats" (
  "id" VARCHAR(40) NOT NULL,
  "status" VARCHAR(40) NOT NULL,
  "details" JSONB NOT NULL,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "process_heartbeats_pkey" PRIMARY KEY ("id")
);
