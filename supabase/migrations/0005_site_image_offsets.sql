-- ---------------------------------------------------------------------------
-- Per-image framing offsets. Lets a human nudge an uploaded photo left/right
-- and up/down (in pixels) so it sits well inside whatever crop it appears in.
-- Applied everywhere the image_key renders, via CSS object-position.
--   offset_x > 0  => move the photo to the right
--   offset_y > 0  => move the photo down
-- Range is clamped to +/- 100px on each axis.
-- ---------------------------------------------------------------------------
alter table site_images
  add column if not exists offset_x int not null default 0,
  add column if not exists offset_y int not null default 0;

alter table site_images
  drop constraint if exists site_images_offset_x_range;
alter table site_images
  add constraint site_images_offset_x_range check (offset_x between -100 and 100);

alter table site_images
  drop constraint if exists site_images_offset_y_range;
alter table site_images
  add constraint site_images_offset_y_range check (offset_y between -100 and 100);
