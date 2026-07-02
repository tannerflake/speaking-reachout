-- ===========================================================================
-- Email reply/bounce tracking — powers the "Scan email for status updates"
-- button on the Dashboard and Leads views. Additive; run after prior migrations.
-- ===========================================================================

-- When a scan detects a response in a sent outreach's thread, we stamp the
-- outreach so the UI can show reply/bounce state and so we stay idempotent.
alter table outreach add column if not exists replied_at timestamptz;
alter table outreach add column if not exists bounced_at timestamptz;

-- Dedup for the reply scanner. Kept SEPARATE from processed_messages (owned by
-- Voice & Insights analysis) so the two features never hide messages from each
-- other — each maintains its own "already looked at this" set.
create table if not exists reply_scan_messages (
  gmail_message_id text primary key,
  internal_date    timestamptz,
  scanned_at       timestamptz not null default now()
);

alter table reply_scan_messages enable row level security;

create policy reply_scan_messages_authenticated_all
  on reply_scan_messages for all to authenticated using (true) with check (true);
