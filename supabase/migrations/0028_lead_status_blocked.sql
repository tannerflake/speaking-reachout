-- Add a "blocked" lead status.
--
-- For a lead the engagement guard refuses: the organization is already in a
-- conversation (a sibling lead replied or was emailed by hand, or the mailbox
-- has an existing thread). Set automatically from "new" when drafting or
-- sending is refused, and back to "new" if the conflict goes away, so these
-- leads leave the New backlog instead of being retried by every bulk run.

alter table leads drop constraint if exists leads_status_check;
alter table leads
  add constraint leads_status_check
  check (status in ('new', 'blocked', 'reached_out',
                    'followup_1', 'followup_2', 'followup_3',
                    'interested', 'booked', 'closed', 'closed_not_me',
                    'not_interested', 'cant_pay', 'junk'));
