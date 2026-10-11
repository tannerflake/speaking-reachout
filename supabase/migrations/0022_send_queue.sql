-- ===========================================================================
-- Throttled bulk send.
--
-- "Send drafts for N leads" no longer fires every email at once. Each draft
-- is marked 'queued' with a scheduled_for time spread across a window (about
-- one email a minute by default), and a sender drains whatever is due: the
-- Leads page while it is open, and /api/cron/send-queue otherwise.
-- ===========================================================================

alter table outreach drop constraint if exists outreach_status_check;
alter table outreach
  add constraint outreach_status_check
  check (status in ('draft', 'queued', 'sent', 'failed'));

alter table outreach add column if not exists scheduled_for timestamptz;

create index if not exists outreach_queue_idx
  on outreach (status, scheduled_for)
  where status = 'queued';
