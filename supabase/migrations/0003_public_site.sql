-- ===========================================================================
-- jeffflake.com public speaker site — schema additions.
-- Run after 0002_voice_insights.sql, then run 0004_seed_site_content.sql.
--
-- Adds the editable content store for the public marketing site, inbound
-- booking leads, the AI site-editor audit log, and a profiles table for
-- role-based admin routing (editor vs CRM admin).
-- ===========================================================================

-- Re-declare the updated_at helper defensively (idempotent) in case this file
-- is run against a fresh database. 0001 already defines it.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- site_content — flexible, editable store for all public copy/imagery.
-- The AI site editor reads/writes JSON blobs keyed by section_key.
-- ---------------------------------------------------------------------------
create table if not exists site_content (
  id            uuid primary key default gen_random_uuid(),
  section_key   text not null,        -- hero, story, topic, media_item, etc.
  sort_order    int  not null default 0,
  data          jsonb not null default '{}'::jsonb,
  is_published  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists site_content_section_idx
  on site_content (section_key, sort_order);
create index if not exists site_content_published_idx
  on site_content (is_published);

create trigger site_content_set_updated_at
  before update on site_content
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- site_images — metadata for swappable imagery. storage_path null => the UI
-- renders a labeled placeholder. Real assets live in the `site-images` bucket.
-- ---------------------------------------------------------------------------
create table if not exists site_images (
  image_key     text primary key,     -- stable key, e.g. hero_primary
  storage_path  text,                 -- path within the site-images bucket
  alt_text      text,
  subject       text,                 -- human note: what belongs here
  updated_at    timestamptz not null default now()
);

create trigger site_images_set_updated_at
  before update on site_images
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- inbound_leads — write-only capture from the public booking form.
-- ---------------------------------------------------------------------------
create table if not exists inbound_leads (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  organization  text not null,
  event_type    text,
  timeframe     text,
  message       text,
  source        text not null default 'website_inbound',
  status        text not null default 'new',
  -- Set once the inbound lead has been mirrored into the CRM `leads` table.
  crm_lead_id   uuid references leads (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists inbound_leads_created_idx
  on inbound_leads (created_at desc);
create index if not exists inbound_leads_status_idx on inbound_leads (status);

-- ---------------------------------------------------------------------------
-- edit_log — audit trail for every applied AI site-editor change (rollback).
-- ---------------------------------------------------------------------------
create table if not exists edit_log (
  id            uuid primary key default gen_random_uuid(),
  user_email    text,
  request_text  text not null,
  diff          jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists edit_log_created_idx on edit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- profiles — distinguishes "editor" (Jeff -> site editor) from "crm_admin"
-- (Tanner/Cheryl -> full CRM). One row per auth user. Absence of a row
-- defaults to crm_admin so the existing operator keeps full access.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  role        text not null default 'crm_admin'
                check (role in ('editor', 'crm_admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- leads.source — tag inbound website leads so they surface in the pipeline
-- alongside discovered (outbound) leads. Existing rows default to 'outbound'.
-- ---------------------------------------------------------------------------
alter table leads
  add column if not exists source text not null default 'outbound';

create index if not exists leads_source_idx on leads (source);

-- ===========================================================================
-- Row Level Security
--   site_content / site_images : public (anon) READ of published rows;
--                                authenticated admin full read/write.
--   inbound_leads              : public (anon) INSERT only. No public select.
--   edit_log / profiles        : authenticated only (no anon access).
-- Server code that bypasses RLS (notification email, CRM mirror, image
-- uploads) uses the service-role key.
-- ===========================================================================
alter table site_content  enable row level security;
alter table site_images   enable row level security;
alter table inbound_leads enable row level security;
alter table edit_log      enable row level security;
alter table profiles      enable row level security;

-- site_content: anon can read published rows; authenticated can do anything.
drop policy if exists site_content_anon_read on site_content;
create policy site_content_anon_read on site_content
  for select to anon using (is_published = true);

drop policy if exists site_content_auth_all on site_content;
create policy site_content_auth_all on site_content
  for all to authenticated using (true) with check (true);

-- site_images: anon read all; authenticated full.
drop policy if exists site_images_anon_read on site_images;
create policy site_images_anon_read on site_images
  for select to anon using (true);

drop policy if exists site_images_auth_all on site_images;
create policy site_images_auth_all on site_images
  for all to authenticated using (true) with check (true);

-- inbound_leads: anon may INSERT only (write-only public capture). No select.
drop policy if exists inbound_leads_anon_insert on inbound_leads;
create policy inbound_leads_anon_insert on inbound_leads
  for insert to anon with check (true);

drop policy if exists inbound_leads_auth_all on inbound_leads;
create policy inbound_leads_auth_all on inbound_leads
  for all to authenticated using (true) with check (true);

-- edit_log: authenticated only.
drop policy if exists edit_log_auth_all on edit_log;
create policy edit_log_auth_all on edit_log
  for all to authenticated using (true) with check (true);

-- profiles: a user may read their own profile; authenticated may read all
-- (single small team). Writes go through the service-role key.
drop policy if exists profiles_auth_read on profiles;
create policy profiles_auth_read on profiles
  for select to authenticated using (true);
