import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also load .env as fallback
import { sql } from "@vercel/postgres";

async function setup() {
  console.log("Creating state_transitions table...");

  await sql`
    CREATE TABLE IF NOT EXISTS state_transitions (
      id              SERIAL PRIMARY KEY,
      issue_id        TEXT NOT NULL,
      identifier      TEXT NOT NULL,
      from_state      TEXT,
      to_state        TEXT NOT NULL,
      transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Add assignee_name column (safe to re-run — skips if exists)
  console.log("Ensuring assignee_name column...");
  await sql`
    DO $$ BEGIN
      ALTER TABLE state_transitions ADD COLUMN assignee_name TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  console.log("Creating indexes...");

  await sql`CREATE INDEX IF NOT EXISTS idx_transitions_issue_id ON state_transitions (issue_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_transitions_identifier ON state_transitions (identifier)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_transitions_to_state ON state_transitions (to_state, transitioned_at)`;

  console.log("Done. Schema is ready.");
}

setup().catch((err) => {
  console.error("Schema setup failed:", err);
  process.exit(1);
});
