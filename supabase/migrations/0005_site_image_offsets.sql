-- ---------------------------------------------------------------------------
-- Per-image framing controls. Let a human nudge and zoom an uploaded photo so
-- it sits well inside whatever crop it appears in. Applied everywhere the
-- image_key renders, via CSS object-position + transform: scale().
--   offset_x > 0  => move the photo to the right
--   offset_y > 0  => move the photo down
--   zoom          => magnification percent (100 = fit, no zoom)
-- offset range is clamped to +/- 100px per axis; zoom to 100..200%.
-- This migration is idempotent; re-running it is safe.
-- ---------------------------------------------------------------------------
alter table site_images
  add column if not exists offset_x int not null default 0,
  add column if not exists offset_y int not null default 0,
  add column if not exists zoom int not null default 100;

alter table site_images
  drop constraint if exists site_images_offset_x_range;
alter table site_images
  add constraint site_images_offset_x_range check (offset_x between -100 and 100);

alter table site_images
  drop constraint if exists site_images_offset_y_range;
alter table site_images
  add constraint site_images_offset_y_range check (offset_y between -100 and 100);

alter table site_images
  drop constraint if exists site_images_zoom_range;
alter table site_images
  add constraint site_images_zoom_range check (zoom between 100 and 200);
