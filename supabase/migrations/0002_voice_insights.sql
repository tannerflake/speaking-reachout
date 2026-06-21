-- ===========================================================================
-- Voice & Insights feature — additive migration.
-- Run after 0001_init.sql.
-- ===========================================================================

-- Store the OAuth scopes granted to the Gmail connection, so the UI can tell
-- whether read access (gmail.readonly) was granted or a reconnect is needed.
alter table gmail_connection add column if not exists scopes text;

-- voice_profile -------------------------------------------------------------
-- One active profile at a time; history preserved via version.
create table if not exists voice_profile (
  id                   uuid primary key default gen_random_uuid(),
  version              int not null default 1,
  is_active            boolean not null default true,
  tone_summary         text,
  structure_summary    text,
  tactics_summary      text,
  cadence_summary      text,
  prompt_injection     text,
  -- Suggested tailoring rules awaiting operator approval. Each:
  -- { id, rule_type, raw_instruction, structured_value, accepted }
  suggested_rules      jsonb not null default '[]'::jsonb,
  source_message_count int not null default 0,
  created_at           timestamptz not null default now()
);

create index if not exists voice_profile_active_idx on voice_profile (is_active);

-- email_insights ------------------------------------------------------------
create table if not exists email_insights (
  id                uuid primary key default gen_random_uuid(),
  voice_profile_id  uuid not null references voice_profile (id) on delete cascade,
  category          text not null
                      check (category in ('voice', 'tactics', 'structure', 'cadence')),
  insight           text not null,
  example_excerpt   text,
  created_at        timestamptz not null default now()
);

create index if not exists email_insights_profile_idx on email_insights (voice_profile_id);

-- processed_messages --------------------------------------------------------
-- Dedup tracking so re-analysis only ingests new mail.
create table if not exists processed_messages (
  id                uuid primary key default gen_random_uuid(),
  gmail_message_id  text not null unique,
  label             text,
  internal_date     timestamptz,
  processed_at      timestamptz not null default now()
);

create index if not exists processed_messages_gmid_idx
  on processed_messages (gmail_message_id);

-- RLS -----------------------------------------------------------------------
alter table voice_profile      enable row level security;
alter table email_insights     enable row level security;
alter table processed_messages enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['voice_profile', 'email_insights', 'processed_messages']
  loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true);',
      t || '_authenticated_all', t
    );
  end loop;
end $$;
