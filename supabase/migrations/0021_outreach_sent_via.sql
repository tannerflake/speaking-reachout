-- ===========================================================================
-- Who sent the outreach: through this app ("app") or straight from the Gmail
-- inbox ("gmail"). Commission follows the first outreach to a lead, and only
-- app-sent outreach is the operator's, so this has to be recorded on the row
-- at send time rather than inferred later.
--
-- Rows the app sends are written with the default. Rows imported from the
-- mailbox (the fall 2026 campaign) are flipped to "gmail" below.
-- ===========================================================================

alter table outreach
  add column if not exists sent_via text not null default 'app'
    check (sent_via in ('app', 'gmail'));

create index if not exists outreach_sent_via_idx on outreach (sent_via);

-- The fall 2026 campaign was imported from the mailbox on 2026-10-11 and is
-- recognizable by the fit_rationale stamped on its leads.
update outreach o
   set sent_via = 'gmail'
  from leads l
 where l.id = o.lead_id
   and l.fit_rationale like 'Fall 2026 manual Gmail campaign%';
