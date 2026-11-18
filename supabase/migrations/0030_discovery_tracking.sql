-- ===========================================================================
-- Discovery run tracking + server-side enrichment queue.
--
-- Safe to run whether or not 0027_discovery_runs.sql was ever applied: it
-- repeats that migration's statements idempotently, then adds:
--   * per-run accounting (candidates found, duplicates, rule drops, rounds,
--     why the run stopped) and the per-candidate log shown on the Discover
--     page,
--   * a stop flag so "Stop" reaches a run that keeps going server-side,
--   * a per-lead enrichment state so contact finding + drafting runs as a
--     server-side queue that survives closing the tab or starting a new run.
-- ===========================================================================

create table if not exists discovery_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  requested integer not null,
  focus text,
  -- running | done | error. A run left "running" past the function timeout
  -- was cut off (the page shows it as interrupted).
  status text not null default 'running'
    check (status in ('running', 'done', 'error')),
  inserted integer not null default 0,
  raw_count integer,
  failed_batches integer,
  error text
);

create index if not exists discovery_runs_created_at_idx
  on discovery_runs (created_at desc);

-- Service-role only (written from server code with the admin client).
alter table discovery_runs enable row level security;

alter table discovery_runs
  -- Candidates dropped because the org is already in the system.
  add column if not exists duplicates integer,
  -- Candidates returned more than once within the same run.
  add column if not exists repeats integer,
  -- Candidates dropped by tailoring rules (incl. the think-tank ban).
  add column if not exists rule_filtered integer,
  -- Valid candidates left over once the requested count was reached.
  add column if not exists surplus integer,
  add column if not exists rounds integer,
  add column if not exists searches integer,
  -- target_reached | time_budget | max_rounds | exhausted | stopped | errors
  add column if not exists stop_reason text,
  -- [{ name, outcome, reason, round }] for every candidate the models proposed.
  add column if not exists candidates jsonb,
  add column if not exists auto_enrich boolean not null default false,
  add column if not exists cancel_requested boolean not null default false;

alter table leads
  add column if not exists discovery_run_id uuid
    references discovery_runs (id) on delete set null,
  -- Contact finding + drafting queue: null (never queued) | pending |
  -- working | done | error.
  add column if not exists enrich_status text
    check (enrich_status in ('pending', 'working', 'done', 'error')),
  add column if not exists enrich_started_at timestamptz,
  add column if not exists enrich_finished_at timestamptz,
  add column if not exists enrich_attempts integer not null default 0,
  add column if not exists enrich_error text;

create index if not exists leads_discovery_run_id_idx
  on leads (discovery_run_id);

create index if not exists leads_enrich_queue_idx
  on leads (enrich_status, created_at)
  where enrich_status in ('pending', 'working');

-- Make the new table and columns visible to the API right away.
notify pgrst, 'reload schema';
