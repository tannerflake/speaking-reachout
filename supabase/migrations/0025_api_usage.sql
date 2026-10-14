-- ===========================================================================
-- Per-call Claude API usage, so spend can be attributed to a feature
-- (discovery, outreach drafting, contact finding, follow-ups, ...) instead of
-- showing up as one undifferentiated bill. Written best-effort by the server
-- after every Claude call; a failed insert never fails the call itself.
-- ===========================================================================

create table if not exists api_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- What the call was for: discovery | outreach | contacts | followup |
  -- voice | rule | site | classify (free text so new features need no migration).
  feature text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  web_search_requests integer not null default 0,
  -- Number of API round-trips folded into this row (pause_turn resumes).
  requests integer not null default 1,
  duration_ms integer,
  ok boolean not null default true,
  error text
);

create index if not exists api_usage_created_at_idx on api_usage (created_at desc);
create index if not exists api_usage_feature_idx on api_usage (feature, created_at desc);

-- Service-role only (written from server code with the admin client).
alter table api_usage enable row level security;
