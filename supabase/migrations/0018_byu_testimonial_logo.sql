-- ---------------------------------------------------------------------------
-- Show the Brigham Young University logo faintly behind its testimonial card.
-- The BYU logo asset already exists (site_images.image_key =
-- 'brigham_young_university', uploaded via the site manager) and the "Recent &
-- upcoming engagements" BYU card already resolves it automatically via its
-- name slug. Testimonials need an explicit image_key, so point the BYU
-- testimonial at that same asset.
--
-- Targeted by attribution rather than row id so it replays on any DB that has
-- a BYU testimonial. Applied to the live DB on 2026-07-02; idempotent.
-- ---------------------------------------------------------------------------
update site_content
set data = jsonb_set(data, '{image_key}', '"brigham_young_university"')
where section_key = 'testimonial'
  and data->>'attribution' = 'Brigham Young University';
