-- ---------------------------------------------------------------------------
-- Island story beat becomes a single photo: drop the extra gallery photos and
-- the embedded video, leaving only the main image_key (story_island).
-- Also removes the now-orphaned placeholder image keys. Idempotent.
-- (Applied to the live DB on 2026-06-22; this records it for other environments
--  and migration replays.)
-- ---------------------------------------------------------------------------
update site_content
set data = (data - 'gallery') - 'video_url'
where section_key = 'story'
  and (data ? 'gallery' or data ? 'video_url');

delete from site_images
where image_key in ('story_island_2', 'story_island_3');
