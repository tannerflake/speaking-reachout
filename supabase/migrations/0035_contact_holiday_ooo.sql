-- ===========================================================================
-- Holiday out-of-office per contact.
--
-- When the reply scanner sees a holiday out-of-office auto-reply (Thanksgiving,
-- Christmas, New Year, "the holidays", or a stated return date between Dec 20
-- and Jan 12), it marks THAT contact as out until a resume date (3 business
-- days after their stated return date, or a default when none is stated):
--
--   contacts.ooo_until   date the contact may be emailed again (inclusive).
--                        Nothing is sent to the contact before it; the
--                        follow-up runner and the send queue skip the contact
--                        while ooo_until > today and reschedule to it.
--   contacts.ooo_reason  human-readable reason, e.g. "Holiday OOO: back Jan 2, 2027".
--
-- Lead status is never changed by an auto-reply. Other contacts at the org
-- keep their normal cadence.
--
-- Idempotent. The app tolerates this migration not being applied yet (the
-- follow-up delay still happens via followup_sequences.next_due_at; only the
-- contact badge and the per-contact hard guard need these columns).
-- ===========================================================================

alter table contacts add column if not exists ooo_until date;
alter table contacts add column if not exists ooo_reason text;

create index if not exists contacts_ooo_until_idx
  on contacts (ooo_until)
  where ooo_until is not null;
