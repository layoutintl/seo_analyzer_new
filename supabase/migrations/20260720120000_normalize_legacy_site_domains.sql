-- ===================================================================
--  Normalize legacy sites.domain values
--
--  POST /api/projects and the audit-run upsert now share one identity
--  rule for sites.domain (backend/src/lib/normalizeProjectDomain.ts):
--    - lowercase the hostname
--    - drop a single trailing dot
--    - drop ONE leading "www." label
--
--  Rows created before that rule existed still store raw hostnames
--  such as "www.raya.com". Creating a project for the same website
--  now normalizes to "raya.com", misses the ON CONFLICT (domain)
--  clause, and inserts a DUPLICATE project with no audit history.
--
--  This migration rewrites every legacy domain to its normalized form
--  and merges rows that collide:
--    - the OLDEST row of each group survives (it owns the audit
--      history and its id is what external tooling has recorded)
--    - audit_runs are repointed to the surviving row
--    - seed_urls are repointed only when the survivor has none
--    - project_name / website_url / last_form_values are kept from
--      the survivor when present, otherwise taken from the newest
--      duplicate that has them; last_audit_at becomes the greatest
--    - duplicate rows are deleted (cascades clean up leftovers)
--
--  Idempotent: after the first run every domain is already in
--  normalized form and the loop body never executes.
-- ===================================================================

-- Mirror of normalizeProjectDomain() for values already stored in
-- sites.domain (bare hostname, optionally with a :port suffix).
CREATE FUNCTION pg_temp.norm_site_domain(d TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT CASE
           WHEN h LIKE 'www.%' AND length(h) > 4 THEN substr(h, 5)
           ELSE h
         END
  FROM (
    SELECT regexp_replace(lower(trim(d)), '\.$', '') AS h
  ) s
$f$;

DO $$
DECLARE
  v_norm TEXT;
  v_tgt  sites%ROWTYPE;
  v_src  sites%ROWTYPE;
BEGIN
  FOR v_norm IN
    SELECT DISTINCT pg_temp.norm_site_domain(domain)
    FROM sites
    WHERE pg_temp.norm_site_domain(domain) <> domain
  LOOP
    -- Survivor: the oldest row among every spelling of this domain.
    SELECT * INTO v_tgt
    FROM sites
    WHERE pg_temp.norm_site_domain(domain) = v_norm
    ORDER BY created_at ASC, id ASC
    LIMIT 1;

    -- Merge every other spelling into the survivor, newest first:
    -- COALESCE keeps the survivor's value once set, so the newest
    -- duplicate is the one that fills any gap the survivor has.
    FOR v_src IN
      SELECT * FROM sites
      WHERE pg_temp.norm_site_domain(domain) = v_norm
        AND id <> v_tgt.id
      ORDER BY created_at DESC, id DESC
    LOOP
      UPDATE audit_runs SET site_id = v_tgt.id WHERE site_id = v_src.id;

      IF NOT EXISTS (SELECT 1 FROM seed_urls WHERE site_id = v_tgt.id) THEN
        UPDATE seed_urls SET site_id = v_tgt.id WHERE site_id = v_src.id;
      END IF;

      UPDATE sites
      SET project_name     = COALESCE(sites.project_name,     v_src.project_name),
          name             = COALESCE(sites.name,             v_src.name),
          website_url      = COALESCE(sites.website_url,      v_src.website_url),
          last_form_values = COALESCE(sites.last_form_values, v_src.last_form_values),
          last_audit_at    = GREATEST(sites.last_audit_at,    v_src.last_audit_at),
          updated_at       = NOW()
      WHERE id = v_tgt.id;

      DELETE FROM sites WHERE id = v_src.id;
    END LOOP;

    UPDATE sites
    SET domain = v_norm, updated_at = NOW()
    WHERE id = v_tgt.id AND domain <> v_norm;
  END LOOP;
END $$;
