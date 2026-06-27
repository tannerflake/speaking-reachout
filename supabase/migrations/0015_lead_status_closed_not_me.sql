-- Add a "closed_not_me" lead status.
--
-- This marks venues that were closed/booked OUTSIDE this CRM (e.g. speeches
-- Jeff Flake's office arranged directly), as opposed to "closed" which we drive
-- through our own outreach. Keeping them as leads means discovery dedups against
-- them and never resurfaces them. It is applied manually / via data migration,
-- so it is intentionally absent from PIPELINE_STATUSES in the app.

alter table leads drop constraint if exists leads_status_check;

alter table leads
  add constraint leads_status_check
  check (status in ('new', 'reached_out', 'interested',
                    'booked', 'closed', 'closed_not_me', 'not_interested'));
