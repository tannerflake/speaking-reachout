-- ---------------------------------------------------------------------------
-- Refresh the "In the Media" items with current, linked stories (each now has
-- an outlet and an outbound URL). Upserts by id so the five original seed rows
-- (0004) are replaced in place and a sixth is added. Applied to the live DB on
-- 2026-06-22; recorded here for replays.
-- ---------------------------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('80000000-0000-4000-8000-000000000001', 'media_item', 1, jsonb_build_object(
    'title', 'Compromising on Character Comes With a Cost', 'outlet', 'The Washington Post',
    'url', 'https://www.washingtonpost.com/opinions/2026/06/10/jeff-flake-graham-platner-maine-democrats-face-test/')),
  ('80000000-0000-4000-8000-000000000002', 'media_item', 2, jsonb_build_object(
    'title', 'The Fever Must Break', 'outlet', 'The New York Times',
    'url', 'https://www.nytimes.com/2025/07/06/opinion/trump-tillis-senate-republicans.html')),
  ('80000000-0000-4000-8000-000000000003', 'media_item', 3, jsonb_build_object(
    'title', 'The Case for Soft Power', 'outlet', 'Deseret News',
    'url', 'https://www.deseret.com/magazine/2025/06/14/jeff-flake-the-case-for-soft-power/')),
  ('80000000-0000-4000-8000-000000000004', 'media_item', 4, jsonb_build_object(
    'title', 'Legislative Atrophy', 'outlet', 'CNN',
    'url', 'https://www.cnn.com/2025/06/19/Tv/video/amanpour-flake')),
  ('80000000-0000-4000-8000-000000000005', 'media_item', 5, jsonb_build_object(
    'title', 'As America Steps Back, Others Step In', 'outlet', 'The Atlantic',
    'url', 'https://www.theatlantic.com/ideas/archive/2025/06/america-steps-back-others-step-in/683048/')),
  ('80000000-0000-4000-8000-000000000006', 'media_item', 6, jsonb_build_object(
    'title', 'The Failure of Leadership', 'outlet', 'The Atlantic',
    'url', 'https://www.theatlantic.com/ideas/2026/03/responsibility-trump-iran-strikes/686407/'))
on conflict (id) do update
  set sort_order = excluded.sort_order,
      data = excluded.data;
