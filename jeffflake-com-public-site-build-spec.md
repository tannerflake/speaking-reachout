# Build Spec — jeffflake.com Public Speaker Site

**Purpose:** Replace the current bare-bones jeffflake.com with a story-driven, photo-heavy, animated marketing site whose single goal is to make people want to **book Ambassador Jeff Flake as a speaker.** This public site is the front door; the existing speaker-outreach CRM becomes the gated admin/back-office behind the same auth.

**Audience for this doc:** A coding agent implementing in one pass. Assume the CRM repo already exists (Next.js App Router + Supabase + Vercel). This spec adds the public marketing site and an AI-driven content editor to that same project.

---

## 1. Context & Constraints

### Existing stack (do not re-architect)
- **Framework:** Next.js (App Router)
- **DB / Auth / Storage:** Supabase (Postgres + Supabase Auth + Supabase Storage for images)
- **Hosting:** Vercel
- **Existing app:** Speaker outreach CRM lives in this same repo. Reuse its Supabase client, auth, and env config. Do not duplicate auth.

### Hard rules
- **Public site is unauthenticated and fast.** No login wall on anything a prospect sees.
- **Admin/CRM is gated** behind existing Supabase Auth. The CRM is effectively "the back of the house."
- **No em dashes** anywhere in generated copy or UI microcopy. Use commas, periods, or parentheticals.
- **Photo-heavy.** Use image placeholders everywhere (documented in Section 7). Tanner will supply real assets.
- **Keep the signature.** Jeff's handwritten-signature graphic is the primary logo/wordmark. Reuse it in the header and footer exactly as on the current site.
- **Story-first, low-text.** Sections should read like chapters of a novel as the user scrolls, with scroll-triggered animation. Prose is tight; imagery carries the weight.

---

## 2. Information Architecture

This is a **single-page scroll-driven narrative** for the home experience, plus a few standalone routes. The current site's separate Bio / In the Media / Contact pages collapse into anchored sections of the scroll story, but we keep deep-link routes for SEO and direct navigation.

```
/                     -> Full scroll narrative (home). Anchored sections below.
/#story               -> The Jeff Flake story (origin -> Congress -> island -> ambassador -> now)
/#speaking            -> What he speaks on + audience types (the "sell")
/#media               -> In the Media (articles, op-eds, the Cuban session video)
/#testimonials        -> What audiences say
/#book                -> Final CTA: Book Jeff Flake as a speaker (contact form)
/bio                  -> Standalone long-form bio (SEO route, mirrors #story content)
/media                -> Standalone In the Media route (SEO)
/admin                -> Gated. Redirects to CRM dashboard if authed, else login.
/admin/login          -> Supabase Auth login
/admin/site-editor    -> AI content manager (Section 6)
```

Header nav (sticky, transparent over hero, solidifies on scroll): **Story · Speaking · Media · Book** + signature logo on the left. Nav links smooth-scroll to anchors on `/`.

---

## 3. The Scroll Narrative (section-by-section)

Each section is a "chapter." Default treatment: large imagery, a short headline, 1 to 3 sentences of copy, scroll-triggered entrance animation. Copy below is **starter copy**, editable later via the AI editor. Keep it tight.

### 3.1 Hero
- Full-viewport. Signature logo top-left. Nav top-right.
- Background: hero portrait or a cinematic action shot (placeholder `hero_primary`).
- Headline (large, confident): **"Book Ambassador Jeff Flake."**
- Subhead: "Senator. Ambassador. Author. A voice that challenges without polarizing."
- Primary CTA button: **"Book Jeff as a Speaker"** -> smooth-scrolls to `#book`.
- Subtle scroll-cue animation (chevron / "scroll" hint) at the bottom.
- Optional kicker above headline: "Jeff Flake, in brief" to set up the story-summary framing Tanner described.

### 3.2 The Story (the chapters)
A vertical, scroll-driven biography. Treat each beat as its own pinned or fading panel. Photo-led. Animations on scroll (fade-up, parallax on imagery, number/stat count-ups where relevant).

**Beat 1 — The Ranch.**
- Image placeholder: `story_ranch` (Jeff as a kid / ranch in Snowflake, Arizona).
- Copy: "He grew up on a cattle ranch in Snowflake, Arizona. Hard work, plain talk, and a deep belief that character comes before party."

**Beat 2 — 18 Years in Congress.**
- Image: `story_congress` (Capitol / official portrait).
- Copy: "Eighteen years representing Arizona in Washington. Twelve years in the House, six in the Senate. He built a reputation for principle over politics."
- Optional animated stat row: `18 years` · `12 House` · `6 Senate`.

**Beat 3 — The Island (feature this).**
- Image: `story_island` (desert island / survival shot).
- This is the personality centerpiece. Copy: "Four times he has been dropped on a remote desert island with little more than his wits. Once, he survived a week stranded with a U.S. senator from across the aisle. It was a living metaphor for what he believes: that Republicans and Democrats can still figure out how to work together."
- Treatment idea: cinematic, slightly different visual tone (warmer, raw) to make this chapter feel like the heart of the story.

**Beat 4 — Ambassador to Türkiye.**
- Image: `story_ambassador` (Türkiye / diplomatic setting / NATO).
- Copy: "After the Senate, he was tapped to serve as U.S. Ambassador to the Republic of Türkiye, where he played a pivotal role in securing Sweden's accession to NATO. In 2025, the Swedish government knighted him with the Royal Order of the Polar Star."

**Beat 5 — Now.**
- Image: `story_now` (ASU / IOP / World Trade Center Utah).
- Copy: "Today he leads as founding Director of the Institute of Politics at Arizona State University and Chairman of the Board of World Trade Center Utah. He is also a New York Times bestselling author and a visiting fellow at Brigham Young University."

**Personality / quirks strip (optional inline within or after the story):**
- A light, scannable row of "things you might not know" cards to show range and humor. Examples (editable): born in Snowflake, AZ; cattle-ranch upbringing; survivalist; father of five; knighted by Sweden. Keep playful, brief, photo-backed.

### 3.3 Speaking — "The Sell"
This is the conversion engine. Level up the current site's "Frequent Topics" + "What type of audiences" sections.

**Topics (expandable cards / accordion, animated on open):**
Pull from current site, keep the click-to-expand interaction but make it slicker. Starter set:
- From Washington to Istanbul
- Courage in Tumultuous Times
- The Art of Negotiation
- The World Needs Leaders
- Leading with Civility
- Bridging America's Divides

Each topic card: title + 1 to 2 sentence description (editable). On expand, reveal the description with a smooth height/opacity animation.

**Audience types (grid of chips/cards):**
Keynote Speeches · Private Lecture Series · University Events · Roundtable Discussions · Expert Panels & Policy Forums · Moderated Q&A Sessions · Leadership Summits · Commencement Addresses · Private Corporate Retreats

**Recent / upcoming engagements (social proof of demand):**
- Recent: Rutgers, Iowa State, Phillips Exeter Academy, Kenyon College, Arizona State University, Utah Valley University, Brigham Young University, The Ohio State University.
- Upcoming: The Truman Library, The Lawrenceville School, University of San Diego.
- Treat as a clean, animated logo/name marquee or grid. These should be **editable** via the AI editor (engagements rotate over time).

**Section CTA:** "Bring Jeff to your stage" -> `#book`.

### 3.4 Watch Jeff in Action (the Cuban session)
- Embedded video module so prospects can see his interviewing/fireside style.
- Reference: Jeff hosted Mark Cuban for the inaugural **Dialogues for Democracy** at ASU (Feb 26, 2025, Mullett Arena). Use the official ASU event page as the canonical link, and embed the YouTube recording once Tanner supplies the video ID.
  - ASU event page: `https://asuevents.asu.edu/event/dialogues-democracy-mark-cuban-hosted-ambassador-jeff-flake`
  - Implement as a responsive 16:9 embed. Use a placeholder/poster image (`media_cuban_poster`) with a play button overlay that loads the YouTube iframe on click (do not autoload the iframe; lazy-load for performance).
  - Make the embed source a **single editable field** (`featured_video_url`) so Jeff/Tanner can swap it for any future talk.
- Copy: "See how he holds a room. A conversation with Mark Cuban at ASU's Institute of Politics."

### 3.5 In the Media
Mirror the current "In the Media" section but elevate it. Logo wall of outlets (New York Times, Deseret News, The Washington Post, CNN, The Atlantic) paired with his op-eds/pieces. Each item is a card: outlet logo + title + outbound link.

Starter items (editable; add real URLs):
- "The Fever Must Break"
- "The Case for Soft Power"
- "It's on You to Speak Out"
- "Avoid Legislative Atrophy"
- "It's Not Too Late"

This is the section Jeff most wants to self-edit (add a new op-ed as it publishes). It must be fully driven by the editable content store (Section 5) so the AI editor can append items.

### 3.6 Testimonials — "What Audiences Say"
Keep the strong quotes from the current site, present them as an animated carousel or staggered grid over a cinematic background. Existing quotes (editable):
- **Rutgers University:** Praised the fireside chat and the informal session for giving students an open dialogue with someone who has navigated national and international politics.
- **Tufts University:** Packed auditorium, lasting positive feedback, students especially valued the private session.
- **United Business Media:** Light-hearted, relatable anecdotes about family and early political life; pleasant and flexible to work with.
- **Amplified Events Strategy:** Engaging, personal, a real professional; would invite him back to any event.
- **Hudson Library & Historical Society:** Loved him; the event went very smoothly.

Note: paraphrase or store the host-provided quotes as content records. Keep attributions.

### 3.7 Final CTA — Book Jeff Flake
- Big, confident closing panel. Portrait (`book_portrait`) + headline **"Book Jeff Flake as a speaker."**
- Contact form (see Section 4). Plus the existing fallback line: "Or email cheryl@jeffflake.com."
- This is the page's primary conversion goal; make it visually unmistakable.

### 3.8 Footer
- Signature logo, quick links (Story, Speaking, Media, Book), `cheryl@jeffflake.com`, copyright "© Jeff Flake [current year]" (compute year dynamically).
- Subtle, no clutter.

---

## 4. Booking Contact Form

A real lead-capture form that feeds the CRM (closing the loop between the public site and the outreach tracker).

**Fields:**
- Name (required)
- Email (required, validated)
- Organization / Institution (required)
- Event type (select: University Event, Keynote, Corporate Retreat, Panel, Q&A, Commencement, Other)
- Proposed date / timeframe (optional, free text or date)
- Message / details (textarea)
- Honeypot field + basic rate limiting for spam.

**On submit:**
- Insert into a Supabase table `inbound_leads` (Section 5).
- Send a notification email to `cheryl@jeffflake.com` (reuse the CRM's Gmail send integration or a transactional email path; do NOT auto-reply to the prospect).
- Show a clean success state ("Thanks. We'll be in touch shortly.").
- **Do not** expose any CRM data publicly. This is write-only from the public side.

**CRM integration:** Inbound leads should surface in the CRM as a new lead source (`source = 'website_inbound'`) so Cheryl/Tanner can triage them alongside outbound prospects. If the CRM has a leads/prospects table, either write directly to it with the inbound source tag or provide a clearly documented mapping. State the assumption in code comments.

---

## 5. Content Model (editable site content)

All public copy/imagery that Jeff might want to change lives in Supabase so the AI editor can update it without code deploys. Use a flexible content store.

**Table: `site_content`**
| column | type | notes |
|---|---|---|
| id | uuid (pk) | |
| section_key | text | e.g. `hero`, `story_island`, `topic`, `media_item`, `testimonial`, `engagement`, `featured_video` |
| sort_order | int | ordering within a section |
| data | jsonb | flexible payload (title, body, image_key, url, attribution, etc.) |
| is_published | bool | default true |
| created_at / updated_at | timestamptz | |

Rationale: single flexible table keeps the AI editor simple (it reads/writes JSON blobs by `section_key`). Seed it with all the starter content above so the site renders on first deploy.

**Table: `site_images`** (or use Supabase Storage with a metadata table)
| column | type | notes |
|---|---|---|
| image_key | text (pk) | stable key referenced by `site_content.data.image_key` (e.g. `hero_primary`) |
| storage_path | text | Supabase Storage path |
| alt_text | text | |
| updated_at | timestamptz | |

Public pages render from `site_content` + `site_images`. Use Next.js caching/ISR or on-demand revalidation so edits show up quickly without a redeploy.

**Table: `inbound_leads`**
| column | type | notes |
|---|---|---|
| id | uuid (pk) | |
| name, email, organization | text | |
| event_type | text | |
| timeframe | text | nullable |
| message | text | |
| source | text | default `website_inbound` |
| status | text | default `new` (mirrors CRM pipeline if shared) |
| created_at | timestamptz | |

**RLS:** Public (anon) role may `INSERT` into `inbound_leads` only (no select). `site_content` / `site_images` are publicly **readable** but writable only by authenticated admin. Lock this down properly.

---

## 6. AI Site Editor (Jeff's "website manager")

The headline feature. A gated, plain-language editor where Jeff pastes a request and AI makes the change. He should not have to touch the page directly.

### 6.1 Access
- Route: `/admin/site-editor`, behind existing Supabase Auth.
- Reachable via a discreet "back door" link (e.g. footer admin link or `/admin`). After login, Jeff lands on a simple editor screen; Tanner/Cheryl land on the full CRM.

### 6.2 UX
- A single large free-text box: "What would you like to change?"
- Examples shown as ghost text / chips:
  - "Add this op-ed to In the Media: [title] + [link]"
  - "Update the island story to mention it was Senator [X]."
  - "Add University of San Diego to upcoming engagements."
  - "Swap the featured video to this YouTube link: [url]"
  - "Change the hero subhead to: [text]"
- He pastes a request (and optionally a story/blurb) and hits **Propose change.**

### 6.3 Flow (propose -> preview -> confirm)
1. **Parse:** Send the request to Claude (Anthropic API, web search not required here) with the current relevant `site_content` records as context. System prompt instructs it to return a **structured diff** as JSON: which `section_key` / record to create, update, or reorder, and the new `data` payload. Enforce the no-em-dash rule in the system prompt AND with a post-processing pass that strips/replaces any em dashes.
2. **Preview:** Render a human-readable before/after diff in the UI. For new media/news items, show the rendered card. Never write blindly.
3. **Confirm:** Jeff clicks **Apply.** Only then does the app write to `site_content` and trigger revalidation of affected pages. (This mirrors the CRM's "always review before send" principle: no silent mutations.)
4. **Log:** Record every applied change in an `edit_log` table (who, when, request text, resulting diff) for safety/rollback.

### 6.4 Scope guardrails
- The editor can: edit copy, add/edit/reorder media items, testimonials, topics, engagements, and swap the featured video and images (by selecting from uploaded `site_images`).
- The editor cannot: change layout/structure, run arbitrary code, alter auth, touch the CRM, or delete content without an explicit confirm step. Destructive ops (delete) require a second confirmation.
- Image uploads: provide a simple upload control that stores to Supabase Storage and registers an `image_key`. The AI can reference existing keys but a human assigns the upload.

### 6.5 Implementation note
- Reuse the CRM's existing Claude API integration/key handling. Keep the editor's API route server-side only. Validate and sanitize the JSON diff before applying (whitelist `section_key`s and `data` fields).

---

## 7. Image Placeholders (Tanner supplies real assets)

Use a consistent, labeled placeholder component (`<Placeholder imageKey="..." aspect="..." />`) that renders a gray block with the key name and intended subject so Tanner knows what goes where. Keys:

| image_key | where | subject |
|---|---|---|
| `hero_primary` | Hero | Cinematic portrait or action shot |
| `story_ranch` | Story beat 1 | Jeff as a kid / Snowflake ranch |
| `story_congress` | Story beat 2 | Capitol / official portrait |
| `story_island` | Story beat 3 | Desert island / survival |
| `story_ambassador` | Story beat 4 | Türkiye / NATO / diplomatic |
| `story_now` | Story beat 5 | ASU IOP / WTC Utah |
| `media_cuban_poster` | Video module | Poster frame of the Cuban talk |
| `book_portrait` | Final CTA | Strong portrait (the current contact-page headshot works) |
| `media_logo_*` | In the Media | Outlet logos (nyt, deseret, wapo, cnn, atlantic) |
| `signature_logo` | Header/footer | Existing handwritten signature (reuse current asset) |

All placeholders should be swappable later purely through `site_images` (no code change needed for the AI-editable ones).

---

## 8. Design & Motion Direction

- **Feel:** slick, cinematic, editorial. "Reads like a good novel as you scroll." Confident, not busy.
- **Palette:** carry the current site's deep navy + white, with the signature blue as the accent. Add warmth in the island chapter. Keep it premium and restrained.
- **Typography:** a strong editorial serif for headlines, clean sans for body. High contrast, generous whitespace, low word count per screen.
- **Motion:** scroll-triggered fade/slide-up entrances, light parallax on imagery, smooth accordion expands, count-up on stats, lazy-loaded video. Use a mature animation lib (Framer Motion). Respect `prefers-reduced-motion`.
- **Performance:** images optimized via `next/image`, lazy-load below the fold, no layout shift, video iframe loads on interaction only. Target fast LCP since this is a conversion page.
- **Responsive:** mobile-first. The scroll story must feel just as good on phones (most prospects will open it on mobile from an email).
- **Accessibility:** semantic headings, alt text on every image (from `site_images.alt_text`), keyboard-navigable accordion and form, visible focus states.

Consult the project's `frontend-design` skill/guidance for token and styling conventions before building components.

---

## 9. Routing, SEO & Meta

- Set proper `<title>`, meta description, Open Graph image (use `hero_primary` or `book_portrait`) so shared links look great in emails and on social.
- Add `/sitemap.xml` and `/robots.txt`. Public routes indexable; `/admin*` disallowed.
- Structured data: `Person` + `Event`/`Service` schema where it makes sense to help "Jeff Flake speaker" search results.
- Preserve `/bio` and `/media` as crawlable routes mirroring the on-page sections.

---

## 10. Build Checklist (for the coding agent)

1. Add public routes (`/`, `/bio`, `/media`) alongside existing CRM. Do not disturb CRM routes.
2. Create Supabase tables: `site_content`, `site_images`, `inbound_leads`, `edit_log`. Add RLS policies (anon: insert leads + read content; authed admin: full).
3. Seed `site_content` with all starter copy and engagements from Section 3. Seed image placeholders.
4. Build the scroll narrative with section components, all reading from `site_content`/`site_images`, with Framer Motion entrances + reduced-motion fallback.
5. Build the booking form -> `inbound_leads` + notify `cheryl@jeffflake.com`; wire into CRM as `source = 'website_inbound'`.
6. Build the lazy-loaded featured-video module (Cuban session) driven by an editable `featured_video_url`.
7. Reuse the signature graphic as logo in header/footer.
8. Build `/admin/site-editor`: free-text request -> Claude structured-diff -> preview -> confirm -> write + revalidate + log. Enforce no-em-dash on input and output. Whitelist writable sections.
9. Gate `/admin*` behind existing Supabase Auth; route admins by role (Jeff -> editor, Tanner/Cheryl -> CRM).
10. SEO/meta/sitemap/OG. Verify Lighthouse performance and accessibility.
11. Confirm the public site deploys cleanly on the existing Vercel project and that env vars (Supabase, Claude, Gmail) carry over.

---

## 11. Out of Scope (for this pass)
- Changing CRM internals or outreach logic.
- Online payment/booking checkout (the CTA is inquiry-based).
- Full multi-user CMS roles beyond "editor" vs "CRM admin."
- Replacing the signature graphic or rebranding.

---

## 12. Open Questions for Tanner
1. Confirm the exact YouTube URL/ID for the Cuban session so it can be embedded (ASU event page is linked as the canonical reference for now).
2. Which Supabase Auth roles distinguish "Jeff = site editor" vs "Tanner/Cheryl = CRM"? (suggest a `role` column on a `profiles` table.)
3. Real outbound URLs for the five "In the Media" op-eds.
4. Should inbound website leads auto-create a CRM prospect record, or land in a separate "inbound" queue for manual promotion? (Spec assumes they tag into the CRM with `website_inbound`.)
