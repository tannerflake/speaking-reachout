-- ---------------------------------------------------------------------------
-- Two changes (applied to the live DB on 2026-06-22; recorded here for replays):
--   1. Add a featured video: Mike Pence's ASU "Dialogues for Democracy" session,
--      slotted between the Cuban session (sort_order 0) and Harvard (sort_order 2).
--   2. Give the Island story beat a modal video (WSJ "Survival" segment) that
--      plays from a small play button on the photo.
-- ---------------------------------------------------------------------------

insert into site_content (id, section_key, sort_order, data) values
  ('70000000-0000-4000-8000-000000000003', 'featured_video', 1, jsonb_build_object(
    'title',     '',
    'caption',   'A conversation with Mike Pence at ASU''s Institute of Politics.',
    'video_url', 'https://www.youtube.com/watch?v=fWXYQBtCOh8',
    'event_url', '',
    'poster_image_key', ''
  ))
on conflict (id) do nothing;

update site_content
set data = jsonb_set(
  data,
  '{modal_video_url}',
  to_jsonb('https://www.youtube.com/watch?v=R0Vo-ckq7Qo'::text)
)
where id = '20000000-0000-4000-8000-000000000003';
