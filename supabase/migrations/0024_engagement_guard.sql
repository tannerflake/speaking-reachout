-- ===========================================================================
-- Engagement guard (lib/outreach/guard.ts).
--
-- Before any email leaves the app, the guard checks whether the organization
-- is already in a conversation: a sibling lead for the same domain/name that
-- is Interested/Booked/etc., a recorded reply, outreach sent by hand from
-- Gmail, or (live) any message to or from that domain in the mailbox. A
-- refused send is parked as 'blocked' and is never retried automatically.
--
-- The operator can override one draft deliberately; the reason is stored on
-- the row and written to the activity log.
-- ===========================================================================

alter table outreach drop constraint if exists outreach_status_check;
alter table outreach
  add constraint outreach_status_check
  check (status in ('draft', 'queued', 'sent', 'failed', 'blocked'));

alter table outreach add column if not exists guard_override_reason text;
alter table outreach add column if not exists guard_override_at timestamptz;
