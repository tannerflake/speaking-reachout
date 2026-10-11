-- ===========================================================================
-- Remember when the paid email provider (Hunter) was already asked about a
-- contact, so a "Find email" click never silently repeats a lookup the
-- automatic enrich pass already made.
-- ===========================================================================

alter table contacts add column if not exists email_lookup_attempted_at timestamptz;
