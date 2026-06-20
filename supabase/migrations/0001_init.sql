-- ===========================================================================
-- Speaker Outreach CRM — initial schema
-- Single-user app. Run this in the Supabase SQL editor (or via the CLI).
-- ===========================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- updated_at trigger helper --------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- leads ----------------------------------------------------------------------
create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  type              text not null default 'other'
                      check (type in ('event', 'institution', 'other')),
  description       text,
  location_country  text,
  location_region   text,
  website           text,
  source_url        text,
  fit_rationale     text,
  suggested_topics  jsonb not null default '[]'::jsonb,
  status            text not null default 'new'
                      check (status in ('new', 'reached_out', 'interested',
                                        'booked', 'closed', 'not_interested')),
  -- Normalized name for dedup: lowercased, punctuation/space stripped.
  name_normalized   text generated always as
                      (regexp_replace(lower(trim(name)), '[^a-z0-9]+', '', 'g')) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists leads_status_idx on leads (status);
create index if not exists leads_country_idx on leads (location_country);
create index if not exists leads_name_normalized_idx on leads (name_normalized);
create index if not exists leads_website_idx on leads (website);

create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();

-- contacts -------------------------------------------------------------------
create table if not exists contacts (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads (id) on delete cascade,
  name            text,
  role            text,
  email           text,
  contact_status  text not null default 'needs_lookup'
                    check (contact_status in ('verified', 'unverified', 'needs_lookup')),
  source_url      text,
  created_at      timestamptz not null default now()
);

create index if not exists contacts_lead_id_idx on contacts (lead_id);

-- outreach -------------------------------------------------------------------
create table if not exists outreach (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads (id) on delete cascade,
  contact_id        uuid references contacts (id) on delete set null,
  subject           text not null,
  body              text not null,
  status            text not null default 'draft'
                      check (status in ('draft', 'sent', 'failed')),
  gmail_message_id  text,
  gmail_thread_id   text,
  error             text,
  sent_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists outreach_lead_id_idx on outreach (lead_id);
create index if not exists outreach_status_idx on outreach (status);

-- bookings -------------------------------------------------------------------
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references leads (id) on delete cascade,
  event_name    text not null,
  event_date    date,
  topic         text,
  fee           numeric,
  is_recurring  boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists bookings_lead_id_idx on bookings (lead_id);

-- tailoring_rules ------------------------------------------------------------
create table if not exists tailoring_rules (
  id               uuid primary key default gen_random_uuid(),
  raw_instruction  text not null,
  rule_type        text not null default 'other'
                     check (rule_type in ('discovery_filter', 'copy_style',
                                          'targeting', 'other')),
  structured_value jsonb not null default '{}'::jsonb,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists tailoring_rules_active_idx on tailoring_rules (is_active);

-- interactions (lightweight activity log) ------------------------------------
create table if not exists interactions (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads (id) on delete cascade,
  kind        text not null
                check (kind in ('status_change', 'note', 'email_sent', 'discovered')),
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists interactions_lead_id_idx on interactions (lead_id);
create index if not exists interactions_created_at_idx on interactions (created_at desc);

-- gmail_connection (single-row; holds the operator's Gmail OAuth refresh token)
-- Not in the spec's table list, but required to persist the Gmail connection
-- securely server-side. Always read/written with the service-role key.
create table if not exists gmail_connection (
  id             integer primary key default 1 check (id = 1),
  email          text,
  refresh_token  text,
  access_token   text,
  expiry         timestamptz,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger gmail_connection_set_updated_at
  before update on gmail_connection
  for each row execute function set_updated_at();

-- ===========================================================================
-- Row Level Security
-- This is a single-operator app gated behind one Supabase Auth login. Any
-- authenticated user may read/write everything; the anon role gets nothing.
-- Server-side code that needs to bypass RLS (discovery inserts, Gmail token
-- storage) uses the service-role key.
-- ===========================================================================
alter table leads            enable row level security;
alter table contacts         enable row level security;
alter table outreach         enable row level security;
alter table bookings         enable row level security;
alter table tailoring_rules  enable row level security;
alter table interactions     enable row level security;
alter table gmail_connection enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'contacts', 'outreach', 'bookings',
    'tailoring_rules', 'interactions'
  ]
  loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true);',
      t || '_authenticated_all', t
    );
  end loop;
end $$;

-- gmail_connection holds a secret (refresh token). Only the service role may
-- touch it — no policy is created for the authenticated role, so RLS denies
-- it by default. (Service-role bypasses RLS entirely.)
