-- Backfill venues Jeff Flake's office closed directly (outside this CRM) so we
-- never reach out to or rediscover them. Inserted as leads with status
-- 'closed_not_me'. Idempotent: skips any org already present in `leads` by
-- normalized name, so re-running is safe.
--
-- NOTE: "Lake Forest Academy" is intentionally omitted — it is still being
-- confirmed, not yet closed.

insert into leads (name, type, status, description)
select v.name, v.type, 'closed_not_me', v.note
from (
  values
    -- 2025-26 academic year
    ('Iowa State University',     'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Kenyon College',            'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Ohio State University',     'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Phillips Exeter Academy',   'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Rutgers University',        'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Utah Valley University',    'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('The Lawrenceville School',  'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('UC San Diego',              'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Truman Library',            'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Arizona State University',  'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    ('Brigham Young University',  'institution', 'Closed directly (not via CRM). 2025-26 academic year speech.'),
    -- 2026-27 academic year
    ('Emory University',                   'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.'),
    ('Lake Forest College',                'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.'),
    ('Boston University',                  'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.'),
    ('Emmanuel College',                   'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.'),
    ('Stanford University',                'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.'),
    ('Boston College',                     'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.'),
    ('University of Michigan Ford School', 'institution', 'Closed directly (not via CRM). 2026-27 academic year speech.')
) as v(name, type, note)
where not exists (
  select 1 from leads l
  where l.name_normalized = regexp_replace(lower(trim(v.name)), '[^a-z0-9]+', '', 'g')
);
