-- ---------------------------------------------------------------------------
-- Give each "In the Media" card an outlet logo, shown faintly behind the card
-- (low opacity + gradient sheen, same treatment as the testimonial cards).
--
-- 1. Seed a placeholder image slot per outlet (storage_path null) so the keys
--    appear in the site manager; a person uploads a transparent PNG to each.
-- 2. Point each media_item at its outlet's image_key (the two Atlantic pieces
--    share the_atlantic).
-- Applied to the live DB on 2026-06-22; recorded here for replays. Idempotent.
-- ---------------------------------------------------------------------------

insert into site_images (image_key, storage_path, alt_text, subject) values
  ('washington_post', null, 'The Washington Post logo', 'The Washington Post logo (media card watermark) — upload a transparent PNG'),
  ('new_york_times',  null, 'The New York Times logo', 'The New York Times logo (media card watermark) — upload a transparent PNG'),
  ('deseret_news',    null, 'Deseret News logo',       'Deseret News logo (media card watermark) — upload a transparent PNG'),
  ('cnn',             null, 'CNN logo',                'CNN logo (media card watermark) — upload a transparent PNG'),
  ('the_atlantic',    null, 'The Atlantic logo',       'The Atlantic logo (media card watermark) — upload a transparent PNG')
on conflict (image_key) do nothing;

update site_content set data = jsonb_set(data, '{image_key}', '"washington_post"')
  where id = '80000000-0000-4000-8000-000000000001';
update site_content set data = jsonb_set(data, '{image_key}', '"new_york_times"')
  where id = '80000000-0000-4000-8000-000000000002';
update site_content set data = jsonb_set(data, '{image_key}', '"deseret_news"')
  where id = '80000000-0000-4000-8000-000000000003';
update site_content set data = jsonb_set(data, '{image_key}', '"cnn"')
  where id = '80000000-0000-4000-8000-000000000004';
update site_content set data = jsonb_set(data, '{image_key}', '"the_atlantic"')
  where id = '80000000-0000-4000-8000-000000000005';
update site_content set data = jsonb_set(data, '{image_key}', '"the_atlantic"')
  where id = '80000000-0000-4000-8000-000000000006';
