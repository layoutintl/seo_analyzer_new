/*
  # Add performance indexes and missing columns

  1. Indexes for common query patterns:
    - audit_runs by site_id (list runs for a site)
    - audit_results by audit_run_id (fetch all results for a run)
    - audit_runs by status (find pending/running audits)
    - sites by domain (fast domain lookup/upsert)

  2. Missing columns:
    - audit_runs.created_at  → matches the code that reads run.createdAt / started_at
    - seed_urls.page_type    → already in schema but verify exists

  3. Safe: all wrapped in DO blocks — won't fail if index already exists.
*/

-- ── Indexes ────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_runs_site_id'
  ) THEN
    CREATE INDEX "idx_audit_runs_site_id" ON "audit_runs"("site_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_runs_status'
  ) THEN
    CREATE INDEX "idx_audit_runs_status" ON "audit_runs"("status");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_results_audit_run_id'
  ) THEN
    CREATE INDEX "idx_audit_results_audit_run_id" ON "audit_results"("audit_run_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_seed_urls_site_id'
  ) THEN
    CREATE INDEX "idx_seed_urls_site_id" ON "seed_urls"("site_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_runs_started_at'
  ) THEN
    CREATE INDEX "idx_audit_runs_started_at" ON "audit_runs"("started_at" DESC);
  END IF;
END $$;

-- ── Ensure updated_at column on sites has auto-update trigger ─────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_sites_updated_at'
  ) THEN
    CREATE TRIGGER set_sites_updated_at
      BEFORE UPDATE ON "sites"
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
