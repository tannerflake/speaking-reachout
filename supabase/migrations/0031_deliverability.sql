-- ===========================================================================
-- Deliverability: bounce protection + one-sender lock for the send queue.
--
-- 1. Contacts gain two terminal statuses, never emailed again:
--      bounced  a hard bounce came back (lib/contacts/deliverability.ts)
--      invalid  the configured email verifier says the mailbox doesn't exist
--    plus bounced_at for when it happened.
--
-- 2. Unchecked Hunter domain-search addresses were saved as "verified". They
--    are Hunter's "seen somewhere" list, not checked mailboxes, and unverified
--    addresses bounce ~27% vs 3.3%. Contacts that look Hunter-sourced (source
--    URL is the bare org homepage, which is how the Hunter paths record it)
--    and have never been emailed go back to "unverified": their drafts are
--    kept but held until a verifier (EMAIL_VERIFIER) or a human confirms them.
--
-- 3. app_locks: a single row the minute send-queue tick takes, so two ticks
--    (cron + an open Leads page) can never send in the same moment.
-- ===========================================================================

alter table contacts drop constraint if exists contacts_contact_status_check;
alter table contacts
  add constraint contacts_contact_status_check
  check (contact_status in ('verified', 'unverified', 'needs_lookup', 'bounced', 'invalid'));

alter table contacts add column if not exists bounced_at timestamptz;

update contacts c
set contact_status = 'unverified'
where c.contact_status = 'verified'
  and c.email is not null
  and c.source_url ~ '^https://[^/]+$'
  and not exists (
    select 1 from outreach o where o.contact_id = c.id and o.status = 'sent'
  );

create table if not exists app_locks (
  name         text primary key,
  locked_until timestamptz not null default now(),
  holder       text
);

insert into app_locks (name, locked_until)
values ('send-queue', now() - interval '1 minute')
on conflict (name) do nothing;

alter table app_locks enable row level security;
drop policy if exists app_locks_authenticated_all on app_locks;
create policy app_locks_authenticated_all
  on app_locks for all to authenticated using (true) with check (true);
