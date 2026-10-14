-- Add a "cant_pay" lead status.
--
-- For a real venue that engaged but ended the conversation because it is
-- unwilling or unable to pay an honorarium. Distinct from "not_interested"
-- (declined for any other reason) so the fee objection is visible in the
-- pipeline and can be revisited if the fee position changes.

alter table leads drop constraint if exists leads_status_check;
alter table leads
  add constraint leads_status_check
  check (status in ('new', 'reached_out',
                    'followup_1', 'followup_2', 'followup_3',
                    'interested', 'booked', 'closed', 'closed_not_me',
                    'not_interested', 'cant_pay', 'junk'));
