-- ===========================================================================
-- Bot import API + engagement history by year.
--
-- 1. bot_api_keys: hashed (sha256 hex) bearer keys for /api/bot/v1. The raw
--    key is never stored. Rotate = insert a new key, set revoked_at on old.
--    Service-role only (RLS on, no policies).
-- 2. bot_activity: one row per bot API call (endpoint, lead, source inbox,
--    summary, HTTP status). Service-role only; shown in Settings > Bot access.
-- 3. lead_messages: full correspondence log (inbound + outbound) imported by
--    bots from any inbox. Dedupe: unique (source_inbox, gmail_message_id) and
--    unique rfc822_message_id (same email seen in two inboxes).
-- 4. interactions.actor / interactions.source_inbox: who wrote an activity
--    entry ('bot:<name>', 'user', 'system') and which inbox it came from.
-- 5. bookings as engagement history: event_year, outcome
--    (completed | upcoming | canceled), event_end_date, location, source,
--    source_inbox, updated_at. Trigger fills event_year/outcome when missing.
--    Safe derived backfill of event_year/outcome for existing rows only.
--
-- Additive only. Idempotent.
-- ===========================================================================

create table if not exists public.bot_api_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Jeff''s bot',
  key_hash text not null unique,
  key_prefix text,
  created_at timestamptz not null default now(),
  created_by text,
  revoked_at timestamptz,
  last_used_at timestamptz
);
alter table public.bot_api_keys enable row level security;

create table if not exists public.bot_activity (
  id uuid primary key default gen_random_uuid(),
  key_id uuid references public.bot_api_keys (id) on delete set null,
  bot_name text,
  method text,
  endpoint text,
  lead_id uuid references public.leads (id) on delete set null,
  source_inbox text,
  summary text,
  status_code integer,
  created_at timestamptz not null default now()
);
create index if not exists bot_activity_created_at_idx on public.bot_activity (created_at desc);
create index if not exists bot_activity_lead_id_idx on public.bot_activity (lead_id);
alter table public.bot_activity enable row level security;

create table if not exists public.lead_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  outreach_id uuid references public.outreach (id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_email text,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  sent_at timestamptz,
  subject text,
  body text,
  snippet text,
  source_inbox text,
  gmail_message_id text,
  gmail_thread_id text,
  rfc822_message_id text,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists lead_messages_inbox_gmail_id_uidx
  on public.lead_messages (source_inbox, gmail_message_id)
  where gmail_message_id is not null;
create unique index if not exists lead_messages_rfc822_uidx
  on public.lead_messages (rfc822_message_id)
  where rfc822_message_id is not null;
create index if not exists lead_messages_gmail_id_idx on public.lead_messages (gmail_message_id);
create index if not exists lead_messages_lead_sent_idx on public.lead_messages (lead_id, sent_at);
create index if not exists lead_messages_thread_idx on public.lead_messages (gmail_thread_id);
alter table public.lead_messages enable row level security;
drop policy if exists lead_messages_authenticated_all on public.lead_messages;
create policy lead_messages_authenticated_all on public.lead_messages
  for all to authenticated using (true) with check (true);

alter table public.interactions add column if not exists actor text;
alter table public.interactions add column if not exists source_inbox text;

alter table public.bookings add column if not exists event_year integer;
alter table public.bookings add column if not exists outcome text;
alter table public.bookings drop constraint if exists bookings_outcome_check;
alter table public.bookings add constraint bookings_outcome_check
  check (outcome is null or outcome in ('completed', 'upcoming', 'canceled'));
alter table public.bookings add column if not exists event_end_date date;
alter table public.bookings add column if not exists location text;
alter table public.bookings add column if not exists source text;
alter table public.bookings add column if not exists source_inbox text;
alter table public.bookings add column if not exists updated_at timestamptz default now();
create index if not exists bookings_event_year_idx on public.bookings (event_year);
create index if not exists bookings_lead_id_idx on public.bookings (lead_id);

-- Year guess from free text: first 4-digit year 2010-2039, ignoring the
-- "Backfilled from Gmail YYYY-MM-DD" stamp.
create or replace function public.booking_guess_year(p_name text, p_notes text)
returns integer language sql immutable as $$
  select coalesce(
    (regexp_match(coalesce(p_name, ''), '\m(20[1-3][0-9])\M'))[1]::int,
    (regexp_match(regexp_replace(coalesce(p_notes, ''),
       'Backfilled from Gmail [0-9]{4}-[0-9]{2}-[0-9]{2}', '', 'g'),
       '\m(20[1-3][0-9])\M'))[1]::int
  );
$$;

create or replace function public.bookings_fill_derived()
returns trigger language plpgsql as $$
begin
  if new.event_date is not null and (new.event_year is null
      or (tg_op = 'UPDATE' and new.event_date is distinct from old.event_date)) then
    new.event_year := extract(year from new.event_date)::int;
  end if;
  if new.event_year is null then
    new.event_year := public.booking_guess_year(new.event_name, new.notes);
  end if;
  if new.outcome is null then
    if new.event_date is not null then
      new.outcome := case when new.event_date >= (now() at time zone 'America/Phoenix')::date
                          then 'upcoming' else 'completed' end;
    elsif new.event_year is not null then
      new.outcome := case when new.event_year > extract(year from (now() at time zone 'America/Phoenix'))::int
                          then 'upcoming' else 'completed' end;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bookings_fill_derived_trg on public.bookings;
create trigger bookings_fill_derived_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_fill_derived();

-- Derived backfill (only fills the new, still-null columns).
update public.bookings b set event_year = coalesce(
    extract(year from b.event_date)::int,
    public.booking_guess_year(b.event_name, b.notes))
  where b.event_year is null;
update public.bookings b set outcome = case
    when b.event_date is not null then
      case when b.event_date >= (now() at time zone 'America/Phoenix')::date then 'upcoming' else 'completed' end
    when b.event_year is not null then
      case when b.event_year > extract(year from (now() at time zone 'America/Phoenix'))::int then 'upcoming' else 'completed' end
  end
  where b.outcome is null;
