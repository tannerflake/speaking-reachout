-- ---------------------------------------------------------------------------
-- Give each "Recent & upcoming engagements" card an institution logo, shown
-- faintly behind the card (low opacity + gradient sheen, same treatment as the
-- media cards). The component derives each card's image_key from a slug of the
-- engagement name (e.g. "Rutgers University" -> "rutgers_university"), so no
-- engagement rows need to change; this only seeds the upload slots so the keys
-- appear in the site manager for a person to upload a transparent PNG.
--
-- Covers the engagements seeded in 0004. Operator-added engagements get their
-- slots seeded in the live DB (and any new one auto-derives its key at render).
-- Applied to the live DB on 2026-06-22; recorded here for replays. Idempotent.
-- ---------------------------------------------------------------------------
insert into site_images (image_key, storage_path, alt_text, subject) values
  ('rutgers_university',       null, 'Rutgers University logo',       'Rutgers University logo (speaking engagement watermark) — upload a transparent PNG'),
  ('iowa_state_university',    null, 'Iowa State University logo',    'Iowa State University logo (speaking engagement watermark) — upload a transparent PNG'),
  ('phillips_exeter_academy',  null, 'Phillips Exeter Academy logo',  'Phillips Exeter Academy logo (speaking engagement watermark) — upload a transparent PNG'),
  ('kenyon_college',           null, 'Kenyon College logo',           'Kenyon College logo (speaking engagement watermark) — upload a transparent PNG'),
  ('arizona_state_university', null, 'Arizona State University logo', 'Arizona State University logo (speaking engagement watermark) — upload a transparent PNG'),
  ('utah_valley_university',   null, 'Utah Valley University logo',   'Utah Valley University logo (speaking engagement watermark) — upload a transparent PNG'),
  ('brigham_young_university', null, 'Brigham Young University logo', 'Brigham Young University logo (speaking engagement watermark) — upload a transparent PNG'),
  ('the_ohio_state_university',null, 'The Ohio State University logo','The Ohio State University logo (speaking engagement watermark) — upload a transparent PNG'),
  ('the_truman_library',       null, 'The Truman Library logo',       'The Truman Library logo (speaking engagement watermark) — upload a transparent PNG'),
  ('the_lawrenceville_school', null, 'The Lawrenceville School logo', 'The Lawrenceville School logo (speaking engagement watermark) — upload a transparent PNG'),
  ('university_of_san_diego',  null, 'University of San Diego logo',  'University of San Diego logo (speaking engagement watermark) — upload a transparent PNG')
on conflict (image_key) do nothing;
