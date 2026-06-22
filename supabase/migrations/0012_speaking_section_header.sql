-- ---------------------------------------------------------------------------
-- Make the Speaking section header/labels editable from the content store
-- (they were hardcoded in the component, so the AI site editor could not change
-- them). Seeds one `speaking` record; the section reads it with fallbacks to the
-- prior hardcoded defaults. The heading is set to the updated copy.
-- Applied to the live DB on 2026-06-22; recorded here for replays.
-- ---------------------------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('c0000000-0000-4000-8000-000000000001', 'speaking', 0, jsonb_build_object(
    'eyebrow',           'Speaking',
    'heading',           'A voice that challenges and informs, never divides.',
    'topics_label',      'Popular topics',
    'audiences_label',   'Formats & audiences',
    'engagements_label', 'Recent & upcoming engagements',
    'cta_label',         'Bring Jeff to your stage'
  ))
on conflict (id) do nothing;
