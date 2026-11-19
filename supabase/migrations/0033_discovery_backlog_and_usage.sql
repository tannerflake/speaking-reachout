-- ===========================================================================
-- 1. Discover keeps its surplus. When a run reaches its requested count, the
--    valid candidates it found beyond that ("extra once the requested count
--    was reached") are saved in discovery_candidates with the run, the focus
--    and the rules active at the time. The next run with the same focus and
--    targeting rules uses ones under 14 days old before searching, after
--    re-running every dedupe and rule check on them (lib/claude/discovery.ts).
--
-- 2. api_usage records every paid provider, not just Anthropic: provider,
--    credits (Hunter searches, verifier checks) and an estimated cost.
--
-- 3. Contacts remember their last email-verifier check, so held addresses are
--    verified once (backfill in lib/contacts/deliverability.ts) instead of
--    being re-checked, and re-billed, on every queue attempt.
--
-- Idempotent. The app works without it (extras are dropped, provider rows
-- are logged without the new columns, the held-address backfill waits).
-- ===========================================================================

create table if not exists discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- The run that found it (null if that run wasn't recorded).
  run_id uuid references discovery_runs (id) on delete set null,
  name text not null,
  name_normalized text not null,
  -- The full candidate as discovery returned it (DiscoveredLead).
  candidate jsonb not null,
  -- Operator focus of the finding run, and the keys a later run must match.
  focus text,
  focus_key text not null default '',
  rules_key text not null default '',
  -- Active discovery_filter + targeting rules at the time, for audit.
  rules_snapshot jsonb not null default '[]'::jsonb,
  -- available: waiting for a run | claimed: a run is checking it now |
  -- used: became a lead | rejected: failed a later dedupe/rule check.
  status text not null default 'available'
    check (status in ('available', 'claimed', 'used', 'rejected')),
  claimed_run_id uuid,
  claimed_at timestamptz,
  used_run_id uuid,
  reject_reason text,
  settled_at timestamptz
);

create index if not exists discovery_candidates_lookup_idx
  on discovery_candidates (status, focus_key, rules_key, created_at desc);

-- Service-role only (written from server code with the admin client).
alter table discovery_candidates enable row level security;

-- A run that crashed mid-claim would strand its rows as "claimed"; free any
-- claim older than an hour (a run lasts at most 5 minutes).
update discovery_candidates
set status = 'available', claimed_run_id = null, claimed_at = null
where status = 'claimed' and claimed_at < now() - interval '1 hour';

alter table discovery_runs
  -- Leads added from earlier runs' saved extras (included in inserted).
  add column if not exists reused integer;

alter table api_usage
  -- anthropic | openai | gemini | hunter | zerobounce | neverbounce
  add column if not exists provider text not null default 'anthropic',
  -- Provider credits used (Hunter searches/verifications, verifier checks).
  add column if not exists credits integer,
  -- Estimated USD for per-call-billed providers (verifiers).
  add column if not exists cost_usd numeric(10, 4);

-- Rows logged before this migration carry the provider only in the model
-- ("hunter/domain-search"); Anthropic model ids never contain a slash.
update api_usage
set provider = split_part(model, '/', 1)
where model like '%/%' and provider = 'anthropic';

create index if not exists api_usage_provider_idx on api_usage (provider, created_at desc);

alter table contacts
  add column if not exists verification_checked_at timestamptz,
  -- e.g. "zerobounce:catch-all"
  add column if not exists verification_result text;
