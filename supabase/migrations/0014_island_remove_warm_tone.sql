-- ---------------------------------------------------------------------------
-- Remove the "warm" tone from the Island story beat so it renders like every
-- other chapter (the warm tone wrapped it in a tan bg-paper-2 panel with a
-- brass left border). Applied to the live DB on 2026-06-22; recorded for replays.
-- ---------------------------------------------------------------------------
update site_content
set data = data - 'tone'
where id = '20000000-0000-4000-8000-000000000003';
