-- ===========================================================================
-- Attribution, lead merging, referred contacts, revisit notes.
--
-- 1. contacts.referred_by_contact_id: a person someone at the org pointed us
--    to ("talk to X instead"). Added on the SAME lead so the lead keeps its
--    attribution (the first sent outreach). Referred contacts are never
--    cold-emailed or followed up automatically; Jeff/Cheryl write to them by
--    hand, and the engagement guard treats the org as in conversation.
--
-- 2. leads.merged_into_id: a duplicate lead merged into another one. The
--    source row is kept (status 'junk', never hard deleted) so Discover and
--    the dedupe/guard logic still know the organization. Hidden from the
--    default lead lists.
--
-- 3. leads.attribution_override*: an explicit, audited override of who
--    started the conversation ('app' = commissionable, 'not_app'). The
--    effective origin is the override when set, else the channel of the
--    earliest sent outreach. Outreach rows (sent_via) are never edited.
--
-- 4. leads.revisit_note: why / when to pick a lead back up. revisit_on now
--    applies to any lead, not only Back burner.
--
-- 5. merge_leads(source, target, actor): moves every child row from source
--    to target in one transaction (see the function comment).
--
-- Idempotent. The app tolerates this migration not being applied yet (the
-- new controls report an error instead of breaking the page).
-- ===========================================================================

alter table contacts
  add column if not exists referred_by_contact_id uuid
    references contacts (id) on delete set null;

-- Optional phone number (entered with a referred contact).
alter table contacts add column if not exists phone text;

create index if not exists contacts_referred_by_idx
  on contacts (referred_by_contact_id)
  where referred_by_contact_id is not null;

alter table leads
  add column if not exists merged_into_id uuid
    references leads (id) on delete set null;

create index if not exists leads_merged_into_idx
  on leads (merged_into_id)
  where merged_into_id is not null;

alter table leads add column if not exists attribution_override text;
alter table leads drop constraint if exists leads_attribution_override_check;
alter table leads
  add constraint leads_attribution_override_check
  check (attribution_override is null or attribution_override in ('app', 'not_app'));
alter table leads add column if not exists attribution_override_reason text;
alter table leads add column if not exists attribution_override_by text;
alter table leads add column if not exists attribution_override_at timestamptz;

alter table leads add column if not exists revisit_note text;

-- Revisit dates now apply to every status (the dashboard looks 14 days ahead).
create index if not exists leads_revisit_on_idx
  on leads (revisit_on)
  where revisit_on is not null;

-- ---------------------------------------------------------------------------
-- merge_leads: fold a duplicate lead (source) into another (target).
--
--   * Contacts move to the target. If the target already has a contact with
--     the same email (case-insensitive), the target's contact is kept: the
--     source contact's outreach, follow-ups and referrals are repointed to
--     it, a bounced/invalid flag is carried over, and the source duplicate
--     row is removed (its email lives on in the target's contact).
--   * Outreach (every row, sent_via untouched), interactions, bookings,
--     follow-up sequences and website-form links move to the target.
--     Attribution therefore follows the earliest sent outreach across both
--     leads; no app-sent outreach row is ever dropped.
--   * Status: the target keeps its own unless the source is further along
--     (back_burner < interested < booked < closed beat everything else).
--   * Revisit date/note: taken from the source only when the target has none.
--   * Attribution override: carried over from the source only when the
--     target has none.
--   * The source is kept with merged_into_id = target and status 'junk'.
--   * An audit note is written on both leads.
--
-- Runs as the caller (RLS applies). Raises on any problem, and since a
-- function body is one transaction, either everything moves or nothing does.
-- ---------------------------------------------------------------------------
create or replace function public.merge_leads(
  p_source uuid,
  p_target uuid,
  p_actor text
) returns jsonb
language plpgsql
as $$
declare
  src leads%rowtype;
  tgt leads%rowtype;
  c record;
  dup_id uuid;
  n_contacts int := 0;
  n_dupes int := 0;
  n_outreach int := 0;
  n_interactions int := 0;
  n_bookings int := 0;
  n_sequences int := 0;
  new_status text;
  first_via text;
  stamp text := to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"');
  actor text := coalesce(nullif(btrim(p_actor), ''), 'unknown user');
  summary text;
begin
  if p_source is null or p_target is null then
    raise exception 'Both leads are required.';
  end if;
  if p_source = p_target then
    raise exception 'A lead cannot be merged into itself.';
  end if;

  -- Lock both rows (in a fixed order) so two merges can't interleave.
  if p_source < p_target then
    select * into src from leads where id = p_source for update;
    select * into tgt from leads where id = p_target for update;
  else
    select * into tgt from leads where id = p_target for update;
    select * into src from leads where id = p_source for update;
  end if;
  if src.id is null then raise exception 'Source lead not found.'; end if;
  if tgt.id is null then raise exception 'Target lead not found.'; end if;
  if src.merged_into_id is not null then
    raise exception 'This lead was already merged into another lead.';
  end if;
  if tgt.merged_into_id is not null then
    raise exception 'The target lead was itself merged into another lead; merge into that one instead.';
  end if;

  -- Interactions first, so the audit notes written below stay where they belong.
  update interactions set lead_id = p_target where lead_id = p_source;
  get diagnostics n_interactions = row_count;

  -- Contacts (dedupe by email against the target).
  for c in select * from contacts where lead_id = p_source order by created_at loop
    dup_id := null;
    if c.email is not null and btrim(c.email) <> '' then
      select id into dup_id
        from contacts
       where lead_id = p_target
         and lower(btrim(email)) = lower(btrim(c.email))
       order by created_at
       limit 1;
    end if;
    if dup_id is not null then
      update outreach set contact_id = dup_id where contact_id = c.id;
      update followup_sequences set contact_id = dup_id where contact_id = c.id;
      update contacts set referred_by_contact_id = dup_id where referred_by_contact_id = c.id;
      if c.contact_status in ('bounced', 'invalid') then
        update contacts set contact_status = c.contact_status
         where id = dup_id and contact_status not in ('bounced', 'invalid');
      end if;
      delete from contacts where id = c.id;
      n_dupes := n_dupes + 1;
    else
      update contacts set lead_id = p_target where id = c.id;
      n_contacts := n_contacts + 1;
    end if;
  end loop;

  update outreach set lead_id = p_target where lead_id = p_source;
  get diagnostics n_outreach = row_count;

  update bookings set lead_id = p_target where lead_id = p_source;
  get diagnostics n_bookings = row_count;

  update followup_sequences set lead_id = p_target where lead_id = p_source;
  get diagnostics n_sequences = row_count;

  update inbound_leads set crm_lead_id = p_target where crm_lead_id = p_source;

  -- Status: keep the target's unless the source is further along.
  new_status := tgt.status;
  if (case src.status when 'back_burner' then 1 when 'interested' then 2
                      when 'booked' then 3 when 'closed' then 4 else 0 end)
     > (case tgt.status when 'back_burner' then 1 when 'interested' then 2
                        when 'booked' then 3 when 'closed' then 4 else 0 end) then
    new_status := src.status;
  end if;

  update leads set
    status = new_status,
    revisit_on = case when tgt.revisit_on is null then src.revisit_on else tgt.revisit_on end,
    revisit_note = case when tgt.revisit_on is null and tgt.revisit_note is null
                        then src.revisit_note else tgt.revisit_note end,
    attribution_override = coalesce(tgt.attribution_override, src.attribution_override),
    attribution_override_reason = case when tgt.attribution_override is null
      then src.attribution_override_reason else tgt.attribution_override_reason end,
    attribution_override_by = case when tgt.attribution_override is null
      then src.attribution_override_by else tgt.attribution_override_by end,
    attribution_override_at = case when tgt.attribution_override is null
      then src.attribution_override_at else tgt.attribution_override_at end
  where id = p_target;

  update leads set merged_into_id = p_target, status = 'junk' where id = p_source;

  -- Effective origin after the merge (for the audit note).
  select sent_via into first_via
    from outreach
   where lead_id = p_target and status = 'sent' and sent_at is not null
   order by sent_at asc
   limit 1;

  summary := format(
    'moved %s contacts (%s duplicate emails folded into existing contacts), %s outreach, %s interactions, %s bookings, %s follow-up sequences. Attribution after merge: %s%s.',
    n_contacts, n_dupes, n_outreach, n_interactions, n_bookings, n_sequences,
    case coalesce(tgt.attribution_override, src.attribution_override)
      when 'app' then 'Sent via app (override)'
      when 'not_app' then 'Not via app (override)'
      else case first_via when 'app' then 'Sent via app'
                          when 'gmail' then 'Sent from Gmail'
                          else 'nothing sent yet' end
    end,
    case when src.status <> tgt.status and new_status = src.status
         then format('; status set to %s from the merged lead', new_status) else '' end
  );

  insert into interactions (lead_id, kind, detail) values
    (p_target, 'note',
     format('Merged lead %s (%s) into this lead by %s on %s; %s', src.name, src.id, actor, stamp, summary)),
    (p_source, 'note',
     format('Merged into %s (%s) by %s on %s; %s', tgt.name, tgt.id, actor, stamp, summary));

  return jsonb_build_object(
    'contacts', n_contacts,
    'duplicates', n_dupes,
    'outreach', n_outreach,
    'interactions', n_interactions,
    'bookings', n_bookings,
    'sequences', n_sequences,
    'status', new_status
  );
end;
$$;

grant execute on function public.merge_leads(uuid, uuid, text) to authenticated;
grant execute on function public.merge_leads(uuid, uuid, text) to service_role;
