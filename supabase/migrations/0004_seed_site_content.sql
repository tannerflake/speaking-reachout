-- ===========================================================================
-- Seed starter content for the jeffflake.com public site.
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING, so re-running never
-- duplicates. Edit live content through /admin/site-editor, not here.
-- Run after 0003_public_site.sql.
-- No em dashes anywhere (hard site rule).
-- ===========================================================================

-- ---- Image placeholders ----------------------------------------------------
insert into site_images (image_key, storage_path, alt_text, subject) values
  ('signature_logo',     null, 'Jeff Flake signature',                    'Existing handwritten signature (reuse current asset)'),
  ('hero_primary',       null, 'Ambassador Jeff Flake',                   'Cinematic portrait or action shot'),
  ('story_ranch',        null, 'Jeff Flake, Snowflake Arizona ranch',     'Jeff as a kid / Snowflake ranch'),
  ('story_congress',     null, 'Jeff Flake official portrait',            'Capitol / official portrait'),
  ('story_island',       null, 'Desert island',                           'Desert island / survival'),
  ('story_ambassador',   null, 'Ambassador Jeff Flake in Turkiye',        'Turkiye / NATO / diplomatic'),
  ('story_now',          null, 'Jeff Flake at ASU',                       'ASU IOP / WTC Utah'),
  ('media_cuban_poster', null, 'Jeff Flake in conversation with Mark Cuban at ASU', 'Poster frame of the Cuban talk'),
  ('book_portrait',      null, 'Ambassador Jeff Flake',                   'Strong portrait (current contact-page headshot works)')
on conflict (image_key) do nothing;

-- ---- Hero ------------------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('10000000-0000-4000-8000-000000000001', 'hero', 0, jsonb_build_object(
    'kicker',    'Jeff Flake, in brief',
    'headline',  'Book Ambassador Jeff Flake.',
    'subhead',   'Senator. Ambassador. Author. A voice that challenges without polarizing.',
    'cta_label', 'Book Jeff as a Speaker',
    'image_key', 'hero_primary'
  ))
on conflict (id) do nothing;

-- ---- Story beats -----------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('20000000-0000-4000-8000-000000000001', 'story', 1, jsonb_build_object(
    'title', 'The Ranch',
    'body',  'He grew up on a cattle ranch in Snowflake, Arizona. Hard work, plain talk, and a deep belief that character comes before party.',
    'image_key', 'story_ranch'
  )),
  ('20000000-0000-4000-8000-000000000002', 'story', 2, jsonb_build_object(
    'title', '18 Years in Congress',
    'body',  'Eighteen years representing Arizona in Washington. Twelve years in the House, six in the Senate. He built a reputation for principle over politics.',
    'image_key', 'story_congress',
    'stats', jsonb_build_array(
      jsonb_build_object('value', 18, 'label', 'Years'),
      jsonb_build_object('value', 12, 'label', 'House'),
      jsonb_build_object('value', 6,  'label', 'Senate')
    )
  )),
  ('20000000-0000-4000-8000-000000000003', 'story', 3, jsonb_build_object(
    'title', 'The Island',
    'body',  'Four times he has been dropped on a remote desert island with little more than his wits. Once, he survived a week stranded with a U.S. senator from across the aisle. It was a living metaphor for what he believes: that Republicans and Democrats can still figure out how to work together.',
    'image_key', 'story_island',
    'tone', 'warm'
  )),
  ('20000000-0000-4000-8000-000000000004', 'story', 4, jsonb_build_object(
    'title', 'Ambassador to Turkiye',
    'body',  'After the Senate, he was tapped to serve as U.S. Ambassador to the Republic of Turkiye, where he played a pivotal role in securing Sweden''s accession to NATO. In 2025, the Swedish government knighted him with the Royal Order of the Polar Star.',
    'image_key', 'story_ambassador'
  )),
  ('20000000-0000-4000-8000-000000000005', 'story', 5, jsonb_build_object(
    'title', 'Now',
    'body',  'Today he leads as founding Director of the Institute of Politics at Arizona State University and Chairman of the Board of World Trade Center Utah. He is also a New York Times bestselling author and a visiting fellow at Brigham Young University.',
    'image_key', 'story_now'
  ))
on conflict (id) do nothing;

-- ---- Quirks strip ----------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('30000000-0000-4000-8000-000000000001', 'quirk', 1, jsonb_build_object('label', 'Born in Snowflake, Arizona')),
  ('30000000-0000-4000-8000-000000000002', 'quirk', 2, jsonb_build_object('label', 'Cattle-ranch upbringing')),
  ('30000000-0000-4000-8000-000000000003', 'quirk', 3, jsonb_build_object('label', 'Four-time desert-island survivalist')),
  ('30000000-0000-4000-8000-000000000004', 'quirk', 4, jsonb_build_object('label', 'Father of five')),
  ('30000000-0000-4000-8000-000000000005', 'quirk', 5, jsonb_build_object('label', 'Knighted by Sweden'))
on conflict (id) do nothing;

-- ---- Speaking topics -------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('40000000-0000-4000-8000-000000000001', 'topic', 1, jsonb_build_object(
    'title', 'From Washington to Istanbul',
    'body',  'A firsthand account of statecraft, from the floor of the U.S. Senate to the front lines of diplomacy as Ambassador to Turkiye.'
  )),
  ('40000000-0000-4000-8000-000000000002', 'topic', 2, jsonb_build_object(
    'title', 'Courage in Tumultuous Times',
    'body',  'What it takes to stand on principle when the easy path is to follow the crowd.'
  )),
  ('40000000-0000-4000-8000-000000000003', 'topic', 3, jsonb_build_object(
    'title', 'The Art of Negotiation',
    'body',  'Lessons in finding common ground, drawn from a career of bipartisan deal-making and high-stakes diplomacy.'
  )),
  ('40000000-0000-4000-8000-000000000004', 'topic', 4, jsonb_build_object(
    'title', 'The World Needs Leaders',
    'body',  'A call for a new generation of principled, service-minded leadership at home and abroad.'
  )),
  ('40000000-0000-4000-8000-000000000005', 'topic', 5, jsonb_build_object(
    'title', 'Leading with Civility',
    'body',  'How good-faith disagreement strengthens institutions, teams, and democracies.'
  )),
  ('40000000-0000-4000-8000-000000000006', 'topic', 6, jsonb_build_object(
    'title', 'Bridging America''s Divides',
    'body',  'A hopeful, practical case that Americans across the aisle can still work together.'
  ))
on conflict (id) do nothing;

-- ---- Audience types --------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('50000000-0000-4000-8000-000000000001', 'audience_type', 1, jsonb_build_object('label', 'Keynote Speeches')),
  ('50000000-0000-4000-8000-000000000002', 'audience_type', 2, jsonb_build_object('label', 'Private Lecture Series')),
  ('50000000-0000-4000-8000-000000000003', 'audience_type', 3, jsonb_build_object('label', 'University Events')),
  ('50000000-0000-4000-8000-000000000004', 'audience_type', 4, jsonb_build_object('label', 'Roundtable Discussions')),
  ('50000000-0000-4000-8000-000000000005', 'audience_type', 5, jsonb_build_object('label', 'Expert Panels & Policy Forums')),
  ('50000000-0000-4000-8000-000000000006', 'audience_type', 6, jsonb_build_object('label', 'Moderated Q&A Sessions')),
  ('50000000-0000-4000-8000-000000000007', 'audience_type', 7, jsonb_build_object('label', 'Leadership Summits')),
  ('50000000-0000-4000-8000-000000000008', 'audience_type', 8, jsonb_build_object('label', 'Commencement Addresses')),
  ('50000000-0000-4000-8000-000000000009', 'audience_type', 9, jsonb_build_object('label', 'Private Corporate Retreats'))
on conflict (id) do nothing;

-- ---- Engagements (recent + upcoming) ---------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('60000000-0000-4000-8000-000000000001', 'engagement', 1,  jsonb_build_object('name', 'Rutgers University',         'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000002', 'engagement', 2,  jsonb_build_object('name', 'Iowa State University',       'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000003', 'engagement', 3,  jsonb_build_object('name', 'Phillips Exeter Academy',     'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000004', 'engagement', 4,  jsonb_build_object('name', 'Kenyon College',              'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000005', 'engagement', 5,  jsonb_build_object('name', 'Arizona State University',    'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000006', 'engagement', 6,  jsonb_build_object('name', 'Utah Valley University',      'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000007', 'engagement', 7,  jsonb_build_object('name', 'Brigham Young University',    'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000008', 'engagement', 8,  jsonb_build_object('name', 'The Ohio State University',   'kind', 'recent')),
  ('60000000-0000-4000-8000-000000000009', 'engagement', 9,  jsonb_build_object('name', 'The Truman Library',          'kind', 'upcoming')),
  ('60000000-0000-4000-8000-000000000010', 'engagement', 10, jsonb_build_object('name', 'The Lawrenceville School',    'kind', 'upcoming')),
  ('60000000-0000-4000-8000-000000000011', 'engagement', 11, jsonb_build_object('name', 'University of San Diego',     'kind', 'upcoming'))
on conflict (id) do nothing;

-- ---- Featured video (Cuban session) ----------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('70000000-0000-4000-8000-000000000001', 'featured_video', 0, jsonb_build_object(
    'title',     'Watch Jeff in Action',
    'caption',   'See how he holds a room. A conversation with Mark Cuban at ASU''s Institute of Politics.',
    'video_url', '',
    'event_url', 'https://asuevents.asu.edu/event/dialogues-democracy-mark-cuban-hosted-ambassador-jeff-flake',
    'poster_image_key', 'media_cuban_poster'
  ))
on conflict (id) do nothing;

-- ---- In the Media ----------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('80000000-0000-4000-8000-000000000001', 'media_item', 1, jsonb_build_object('title', 'The Fever Must Break',        'outlet', '', 'url', '')),
  ('80000000-0000-4000-8000-000000000002', 'media_item', 2, jsonb_build_object('title', 'The Case for Soft Power',     'outlet', '', 'url', '')),
  ('80000000-0000-4000-8000-000000000003', 'media_item', 3, jsonb_build_object('title', 'It''s on You to Speak Out',   'outlet', '', 'url', '')),
  ('80000000-0000-4000-8000-000000000004', 'media_item', 4, jsonb_build_object('title', 'Avoid Legislative Atrophy',   'outlet', '', 'url', '')),
  ('80000000-0000-4000-8000-000000000005', 'media_item', 5, jsonb_build_object('title', 'It''s Not Too Late',          'outlet', '', 'url', ''))
on conflict (id) do nothing;

-- ---- Testimonials ----------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('90000000-0000-4000-8000-000000000001', 'testimonial', 1, jsonb_build_object(
    'quote', 'The fireside chat and the informal session gave students an open dialogue with someone who has navigated national and international politics.',
    'attribution', 'Rutgers University'
  )),
  ('90000000-0000-4000-8000-000000000002', 'testimonial', 2, jsonb_build_object(
    'quote', 'A packed auditorium and lasting positive feedback. Students especially valued the private session.',
    'attribution', 'Tufts University'
  )),
  ('90000000-0000-4000-8000-000000000003', 'testimonial', 3, jsonb_build_object(
    'quote', 'Light-hearted, relatable anecdotes about family and early political life. Pleasant and flexible to work with.',
    'attribution', 'United Business Media'
  )),
  ('90000000-0000-4000-8000-000000000004', 'testimonial', 4, jsonb_build_object(
    'quote', 'Engaging, personal, a real professional. We would invite him back to any event.',
    'attribution', 'Amplified Events Strategy'
  )),
  ('90000000-0000-4000-8000-000000000005', 'testimonial', 5, jsonb_build_object(
    'quote', 'We loved him, and the event went very smoothly.',
    'attribution', 'Hudson Library & Historical Society'
  ))
on conflict (id) do nothing;

-- ---- Final CTA / Book ------------------------------------------------------
insert into site_content (id, section_key, sort_order, data) values
  ('a0000000-0000-4000-8000-000000000001', 'book', 0, jsonb_build_object(
    'headline',       'Book Jeff Flake as a speaker.',
    'body',           'Tell us about your event and we will be in touch shortly.',
    'fallback_email', 'cheryl@jeffflake.com',
    'image_key',      'book_portrait'
  ))
on conflict (id) do nothing;
