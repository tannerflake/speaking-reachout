-- ===========================================================================
-- Discovery run history. Each Discover run gets a row recording what was
-- asked for (count + focus) and what came back, and every lead it inserts is
-- tagged with the run id. The Discover page reads this to show recent runs,
-- so results survive leaving or refreshing the page.
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

alter table leads
  add column if not exists discovery_run_id uuid
    references discovery_runs (id) on delete set null;

create index if not exists leads_discovery_run_id_idx
  on leads (discovery_run_id);
