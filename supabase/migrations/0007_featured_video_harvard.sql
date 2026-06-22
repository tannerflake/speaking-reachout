-- Featured video: Jeff Flake's keynote at Harvard Law School Class Day 2018.
-- Renders last among the featured videos (after the two ASU sessions). No
-- poster_image_key, so the VideoEmbed falls back to YouTube's own thumbnail.
insert into site_content (id, section_key, sort_order, data) values
  ('70000000-0000-4000-8000-000000000002', 'featured_video', 2, jsonb_build_object(
    'title',     '',
    'caption',   'His Class Day keynote at Harvard Law School.',
    'video_url', 'https://www.youtube.com/watch?v=yWQg-VG9Euw',
    'event_url', '',
    'poster_image_key', ''
  ))
on conflict (id) do nothing;
