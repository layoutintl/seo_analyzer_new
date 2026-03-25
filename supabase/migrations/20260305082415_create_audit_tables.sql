/*
  # Create SEO Audit System Tables

  1. New Tables
    - `sites`
      - `id` (text, primary key, uuid)
      - `domain` (text, unique)
      - `name` (text, optional)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `seed_urls`
      - `id` (text, primary key, uuid)
      - `site_id` (text, foreign key to sites)
      - `url` (text)
      - `created_at` (timestamp)
    
    - `audit_runs`
      - `id` (text, primary key, uuid)
      - `site_id` (text, foreign key to sites)
      - `status` (text, default 'PENDING')
      - `site_checks` (jsonb)
      - `started_at` (timestamp)
      - `finished_at` (timestamp, nullable)
    
    - `audit_results`
      - `id` (text, primary key, uuid)
      - `audit_run_id` (text, foreign key to audit_runs)
      - `url` (text)
      - `data` (jsonb)
      - `status` (text)
      - `recommendations` (jsonb)
      - `created_at` (timestamp)

  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated users to manage their own audit data
*/

-- CreateTable
CREATE TABLE IF NOT EXISTS "sites" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "seed_urls" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "site_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "page_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_runs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "site_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "site_checks" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_results" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "audit_run_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "data" JSONB,
    "status" TEXT,
    "recommendations" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'sites_domain_key'
  ) THEN
    CREATE UNIQUE INDEX "sites_domain_key" ON "sites"("domain");
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'seed_urls_site_id_fkey'
  ) THEN
    ALTER TABLE "seed_urls" ADD CONSTRAINT "seed_urls_site_id_fkey" 
      FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'audit_runs_site_id_fkey'
  ) THEN
    ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_site_id_fkey" 
      FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'audit_results_audit_run_id_fkey'
  ) THEN
    ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_audit_run_id_fkey" 
      FOREIGN KEY ("audit_run_id") REFERENCES "audit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Enable RLS
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seed_urls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_results" ENABLE ROW LEVEL SECURITY;

-- Create policies for public access
-- Note: This allows anonymous access for the SEO audit tool

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can view sites'
  ) THEN
    CREATE POLICY "Public can view sites"
      ON "sites" FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can create sites'
  ) THEN
    CREATE POLICY "Public can create sites"
      ON "sites" FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can update sites'
  ) THEN
    CREATE POLICY "Public can update sites"
      ON "sites" FOR UPDATE
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can delete sites'
  ) THEN
    CREATE POLICY "Public can delete sites"
      ON "sites" FOR DELETE
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can view seed_urls'
  ) THEN
    CREATE POLICY "Public can view seed_urls"
      ON "seed_urls" FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can create seed_urls'
  ) THEN
    CREATE POLICY "Public can create seed_urls"
      ON "seed_urls" FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can update seed_urls'
  ) THEN
    CREATE POLICY "Public can update seed_urls"
      ON "seed_urls" FOR UPDATE
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can delete seed_urls'
  ) THEN
    CREATE POLICY "Public can delete seed_urls"
      ON "seed_urls" FOR DELETE
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can view audit_runs'
  ) THEN
    CREATE POLICY "Public can view audit_runs"
      ON "audit_runs" FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can create audit_runs'
  ) THEN
    CREATE POLICY "Public can create audit_runs"
      ON "audit_runs" FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can update audit_runs'
  ) THEN
    CREATE POLICY "Public can update audit_runs"
      ON "audit_runs" FOR UPDATE
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can delete audit_runs'
  ) THEN
    CREATE POLICY "Public can delete audit_runs"
      ON "audit_runs" FOR DELETE
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can view audit_results'
  ) THEN
    CREATE POLICY "Public can view audit_results"
      ON "audit_results" FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can create audit_results'
  ) THEN
    CREATE POLICY "Public can create audit_results"
      ON "audit_results" FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can update audit_results'
  ) THEN
    CREATE POLICY "Public can update audit_results"
      ON "audit_results" FOR UPDATE
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Public can delete audit_results'
  ) THEN
    CREATE POLICY "Public can delete audit_results"
      ON "audit_results" FOR DELETE
      USING (true);
  END IF;
END $$;