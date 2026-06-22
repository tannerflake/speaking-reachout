-- ---------------------------------------------------------------------------
-- "The Book" section: Jeff Flake's published book, Conscience of a Conservative,
-- with its cover image and an Amazon buy link.
--
-- The cover binary was uploaded to the live `site-images` storage bucket on
-- 2026-06-22 (key: book_cover_conscience). This migration seeds the image_key
-- as a placeholder (storage_path null) so fresh environments render the labeled
-- slot until the cover is re-uploaded via the site editor; the content row below
-- carries all the copy and the buy link. Idempotent.
-- ---------------------------------------------------------------------------

insert into site_images (image_key, storage_path, alt_text, subject) values
  ('book_cover_conscience', null, 'Conscience of a Conservative book cover',
   'Cover of Jeff Flake''s book "Conscience of a Conservative"')
on conflict (image_key) do nothing;

insert into site_content (id, section_key, sort_order, data) values
  ('b0000000-0000-4000-8000-000000000001', 'authored_book', 0, jsonb_build_object(
    'eyebrow',           'The Book',
    'badge',             'New York Times Bestseller',
    'title',             'Conscience of a Conservative',
    'subtitle',          'A Rejection of Destructive Politics and a Return to Principle',
    'body',              'In a bold act of conscience, Senator Jeff Flake takes his own party to task for embracing nationalism, populism, and xenophobia—an urgent call to return to bedrock conservative principle and to once again put country before party.',
    'quote',             'A thoughtful defense of traditional conservatism and a thorough assault on the way Donald Trump is betraying it.',
    'quote_attribution', 'David Brooks, The New York Times',
    'url',               'https://www.amazon.com/Conscience-Conservative-Rejection-Destructive-Principle/dp/0399592911',
    'cta_label',         'See more',
    'image_key',         'book_cover_conscience'
  ))
on conflict (id) do nothing;
