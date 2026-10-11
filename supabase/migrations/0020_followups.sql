-- ===========================================================================
-- Automated follow-ups.
--
-- Every sent initial outreach starts a follow-up sequence: up to three short,
-- human-sounding nudges sent in the SAME Gmail thread on a widening cadence
-- (+4 business days, then +7, then +10). The sequence stops the moment the
-- thread gets a reply or bounce, the lead leaves the outreach stage, or the
-- operator pauses it.
--
-- Lead statuses gain followup_1 / followup_2 / followup_3 so the pipeline shows
-- exactly where each lead is in the cadence.
-- ===========================================================================

-- outreach: which step of a sequence a row is (0 = initial, 1..3 = follow-up n)
-- and which initial outreach it belongs to.
alter table outreach add column if not exists sequence_step integer not null default 0;
alter table outreach add column if not exists parent_outreach_id uuid
  references outreach (id) on delete cascade;

create index if not exists outreach_parent_idx on outreach (parent_outreach_id);

-- followup_sequences: one row per sent initial outreach (per recipient).
create table if not exists followup_sequences (
  id            uuid primary key default gen_random_uuid(),
  outreach_id   uuid not null unique references outreach (id) on delete cascade,
  lead_id       uuid not null references leads (id) on delete cascade,
  contact_id    uuid references contacts (id) on delete set null,
  steps_sent    integer not null default 0,
  max_steps     integer not null default 3,
  next_due_at   timestamptz,
  status        text not null default 'active'
                  check (status in ('active', 'paused', 'completed', 'stopped')),
  stop_reason   text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists followup_sequences_due_idx
  on followup_sequences (status, next_due_at);
create index if not exists followup_sequences_lead_idx
  on followup_sequences (lead_id);

create trigger followup_sequences_set_updated_at
  before update on followup_sequences
  for each row execute function set_updated_at();

alter table followup_sequences enable row level security;
create policy followup_sequences_authenticated_all
  on followup_sequences for all to authenticated using (true) with check (true);

-- Lead statuses for each follow-up step.
alter table leads drop constraint if exists leads_status_check;
alter table leads
  add constraint leads_status_check
  check (status in ('new', 'reached_out',
                    'followup_1', 'followup_2', 'followup_3',
                    'interested', 'booked', 'closed', 'closed_not_me',
                    'not_interested', 'junk'));

-- Activity log kind for follow-up sends.
alter table interactions drop constraint if exists interactions_kind_check;
alter table interactions
  add constraint interactions_kind_check
  check (kind in ('status_change', 'note', 'email_sent', 'followup_sent',
                  'discovered'));
