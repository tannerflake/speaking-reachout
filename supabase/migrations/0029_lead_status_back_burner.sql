-- Add a "back_burner" lead status and a "revisit_on" date.
--
-- For an organization that replied with real but deferred interest ("maybe
-- next year", "no budget this cycle", "passing to the committee", "reach out
-- again in the spring"). "interested" now means active interest right now
-- (asking about fee, dates or availability, wanting a call, or considering
-- Jeff for a specific upcoming event).
--
-- Back burner leads behave like Interested ones for automation: no automatic
-- follow-ups, and they count as already in conversation for the engagement
-- guard. revisit_on is an optional date to pick the conversation back up;
-- the scan prefills a best guess when the reply gives a timeframe.

alter table leads drop constraint if exists leads_status_check;
alter table leads
  add constraint leads_status_check
  check (status in ('new', 'blocked', 'reached_out',
                    'followup_1', 'followup_2', 'followup_3',
                    'interested', 'back_burner', 'booked', 'closed',
                    'closed_not_me', 'not_interested', 'cant_pay', 'junk'));

alter table leads add column if not exists revisit_on date;

create index if not exists leads_back_burner_revisit_idx
  on leads (revisit_on)
  where status = 'back_burner';
