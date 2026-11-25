-- ===========================================================================
-- Lead kind: speaking prospects vs. non-booking website inquiries.
--
-- leads.kind = 'speaking' (default, every existing row) or 'inquiry' (press /
-- media, interview or student request, other) submitted through the
-- "Press & other inquiries" form on jeffflake.com. Inquiry leads are handled
-- by hand from Cheryl's inbox and are excluded from outreach drafting,
-- Discover prospects, Find contacts / enrichment, follow-ups, the send queue,
-- reply-scan status automation, revisit lists and pipeline stats.
--
-- leads.inquiry_type says which kind of inquiry (null for speaking leads).
--
-- Existing rows stay 'speaking'; nothing is reclassified here. Idempotent.
-- The app tolerates this migration not being applied yet (no inquiry leads
-- are created and the kind filters are skipped until the column exists).
-- ===========================================================================

alter table public.leads
  add column if not exists kind text not null default 'speaking';

alter table public.leads drop constraint if exists leads_kind_check;
alter table public.leads
  add constraint leads_kind_check check (kind in ('speaking', 'inquiry'));

alter table public.leads add column if not exists inquiry_type text;

alter table public.leads drop constraint if exists leads_inquiry_type_check;
alter table public.leads
  add constraint leads_inquiry_type_check
  check (inquiry_type is null or inquiry_type in ('press', 'interview_student', 'other'));

create index if not exists leads_kind_idx on public.leads (kind);
