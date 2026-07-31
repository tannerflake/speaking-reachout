-- Add a "junk" lead status.
--
-- For leads that were never viable — bad discovery results, spam form fills,
-- duplicates of things that aren't real venues. Distinct from "not_interested"
-- (a real venue that declined). Keeping them as leads means discovery dedups
-- against them and never resurfaces them.

alter table leads drop constraint if exists leads_status_check;

alter table leads
  add constraint leads_status_check
  check (status in ('new', 'reached_out', 'interested',
                    'booked', 'closed', 'closed_not_me', 'not_interested',
                    'junk'));
