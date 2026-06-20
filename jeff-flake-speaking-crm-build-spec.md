# Speaker Outreach CRM — Build Spec

**Purpose:** A single-user web app to generate, send, and track speaking-engagement outreach for Jeff Flake.
**Build target:** Ship the entire app from this document in one pass.
**Stack:** Next.js (App Router) + Supabase (Postgres, Auth, Storage) + Vercel.

---

## 0. Build Directives for the Coding Agent

- Build this as a **single-user app**. One operator account (Jeff / family). No multi-tenant logic, no org/team model. Gate the whole app behind one Supabase Auth login.
- Ship a **working, deployed-ready app**, not scaffolding. Every feature below should function end to end against real Supabase + Gmail + Claude credentials supplied via env vars.
- Outreach **always lands as a reviewable draft the operator approves before send**. The "one-click send" is a one-click *approve-and-send* on an already-generated draft. Never auto-send without an explicit approve click.
- **Never fabricate contact emails.** If a real email can't be resolved for a lead, store it as `contact_status = 'needs_lookup'` and surface it in the UI. Do not invent addresses.
- Persist the operator's natural-language tailoring instructions as **structured rules** the AI reads on every generation (see Section 6). These rules are permanent until edited/deleted.
- Use environment variables for all secrets. Provide a `.env.example`. Never hardcode keys.
- Write clean, typed code (TypeScript). Include a `README.md` with setup, env vars, Supabase migration steps, and Gmail OAuth setup.

---

## 1. What We're Building (Plain Language)

Jeff gets paid to speak at events, universities, and institutions. Today the process is manual: pull a list of prospects, email them by hand, cc family on replies, track nothing.

This app replaces that with a lightweight CRM + AI outreach engine:

1. **Discover** generates batches of new, qualified speaking-engagement leads with contact info, excluding anyone already in the system.
2. For any lead, the app **auto-drafts a tailored outreach email** — researched, specific, and persuasive about why Jeff fits *that* event/institution.
3. The operator reviews, optionally edits, and sends from Jeff's Gmail with one click.
4. Everything is **tracked** through a pipeline: reached out → interested → booked → closed.
5. A **natural-language settings panel** lets the operator tune outreach behavior in perpetuity ("stop pulling leads from X country," "no em-dashes," "lean more academic").

Scope is **top of funnel only.** Generate leads, send outreach, track status. No relationship nurturing or contract management yet.

---

## 2. Core User Flows

### Flow A — Discover Leads
1. Operator clicks **Discover** and requests N leads (default 50).
2. App calls Claude (with web search) to find real institutions/events that fit Jeff as a speaker.
3. For each lead, app resolves contact info (see Section 5).
4. Leads are **deduped against the entire database** (anyone already reached out to, or already in the lead pool, is excluded).
5. New leads land in the **Leads** view as `status = 'new'`.

### Flow B — Generate & Send Outreach
1. Operator opens a lead and clicks **Draft Outreach**.
2. App researches the org/event and generates a tailored email (subject + body), applying all active tailoring rules.
3. Draft renders in an editable panel. Operator can edit inline.
4. Operator clicks **Approve & Send** → app sends via Gmail API from Jeff's account.
5. Status auto-advances to `reached_out`; the sent email + timestamp are logged.

### Flow C — Track the Pipeline
1. Operator updates a lead's status as things progress: `interested`, `booked`, `closed`, or `not_interested`.
2. `booked` captures event name, date, topic, fee (optional), and a **recurring** flag.
3. Recurring booked events surface a **"Reach out again"** action when appropriate.

### Flow D — Tune the AI (Natural Language)
1. Operator types an instruction into the **Tailoring** panel (e.g. "Don't pull leads from the UK").
2. App parses it into a structured rule and saves it.
3. All future Discover + Draft operations respect active rules.

---

## 3. Data Model (Supabase / Postgres)

Create these tables via SQL migration. Use `uuid` PKs (`gen_random_uuid()`), `created_at`/`updated_at` timestamptz defaults.

### `leads`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name | text | Institution / event / org name |
| type | text | `event` \| `institution` \| `other` |
| description | text | What the org/event is |
| location_country | text | Used for country-based filtering rules |
| location_region | text | City/state, nullable |
| website | text | nullable |
| source_url | text | Where it was discovered, nullable |
| fit_rationale | text | Why Claude flagged this as a fit for Jeff |
| suggested_topics | jsonb | Array of topic ideas for this lead |
| status | text | `new` \| `reached_out` \| `interested` \| `booked` \| `closed` \| `not_interested` |
| created_at / updated_at | timestamptz | |

### `contacts`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| lead_id | uuid FK → leads | |
| name | text | nullable |
| role | text | nullable (e.g. "Events Director") |
| email | text | nullable |
| contact_status | text | `verified` \| `unverified` \| `needs_lookup` |
| source_url | text | nullable |

### `outreach`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| lead_id | uuid FK → leads | |
| contact_id | uuid FK → contacts | nullable |
| subject | text | |
| body | text | |
| status | text | `draft` \| `sent` \| `failed` |
| gmail_message_id | text | nullable, set on send |
| gmail_thread_id | text | nullable |
| sent_at | timestamptz | nullable |
| created_at | timestamptz | |

### `bookings`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| lead_id | uuid FK → leads | |
| event_name | text | |
| event_date | date | nullable |
| topic | text | nullable |
| fee | numeric | nullable |
| is_recurring | boolean | default false |
| notes | text | nullable |
| created_at | timestamptz | |

### `tailoring_rules`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| raw_instruction | text | Exactly what the operator typed |
| rule_type | text | `discovery_filter` \| `copy_style` \| `targeting` \| `other` |
| structured_value | jsonb | Parsed/normalized rule the engine applies |
| is_active | boolean | default true |
| created_at | timestamptz | |

### `interactions` (lightweight activity log)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| lead_id | uuid FK → leads | |
| kind | text | `status_change` \| `note` \| `email_sent` |
| detail | text | |
| created_at | timestamptz | |

**Dedup rule:** Discover must exclude any candidate whose normalized `name` (lowercased, trimmed, punctuation-stripped) or `website` domain already exists in `leads`.

---

## 4. Pages & UI

Build with Next.js App Router + Tailwind. Clean, dense, functional. No marketing polish needed; this is an internal tool.

### `/` — Dashboard
- Pipeline summary: counts per status (`new`, `reached_out`, `interested`, `booked`, `closed`).
- Quick actions: **Discover Leads**, **View Leads**, **Tailoring Settings**.
- Recent activity feed from `interactions`.

### `/leads` — Leads List
- Filterable table: name, type, country, status, # contacts, last activity.
- Filters by status, country, type. Search by name.
- Row click → lead detail.
- Bulk action: select multiple `new` leads → **Draft Outreach** for each.

### `/leads/[id]` — Lead Detail
- Lead info, fit rationale, suggested topics, contacts (with `contact_status` badges).
- **Draft Outreach** button → opens draft panel.
- Outreach history (drafts + sent, with timestamps and Gmail links).
- Status control (dropdown or pipeline buttons).
- If `booked`: booking form (event name, date, topic, fee, recurring).
- `needs_lookup` contacts show a clear "Find email manually" prompt with the org website linked.

### `/discover` — Discover
- Input: number of leads (default 50), optional free-text focus ("universities in the Mountain West", "fintech conferences").
- Run button → progress state → results land in `leads` as `new`.
- Shows active tailoring rules that will apply, so the operator knows what's being filtered.

### `/outreach/[id]` (or modal) — Draft Review
- Editable subject + body.
- Shows which contact it's addressed to.
- **Approve & Send**, **Save Draft**, **Regenerate** (with optional one-off instruction).

### `/settings/tailoring` — Tailoring Panel
- Free-text box: "Tell the AI how to behave."
- List of active rules with `raw_instruction`, type badge, toggle active/inactive, delete.
- New instructions are parsed into structured rules on submit (see Section 6).

---

## 5. Lead Discovery Engine (Section detail)

**Engine:** Claude API (`claude-opus-4-8` or current) with the built-in **web search tool** enabled.

**Step 1 — Find & qualify.** Prompt Claude to return N real institutions/events that are plausible paying speaking venues for Jeff Flake, given any operator focus text and active `targeting`/`discovery_filter` rules. Require structured JSON output per lead: `name`, `type`, `description`, `location_country`, `location_region`, `website`, `source_url`, `fit_rationale`, `suggested_topics[]`.

- Instruct Claude to return **only real, verifiable organizations** found via web search, with a `source_url` for each. Discard any lead without a source.

**Step 2 — Resolve contacts.** For each qualified lead, attempt to find a real contact (events director, program chair, booking/comms contact) and email.

- Implement contact resolution as a **swappable provider interface** (`ContactResolver`) so a dedicated email-finding API (Hunter.io, Apollo, etc.) can be dropped in later via env config.
- Default implementation: use Claude + web search to find a publicly listed contact email from the org's official site/contact page. Set `contact_status`:
  - `verified` only if pulled from an official source page,
  - `unverified` if inferred,
  - `needs_lookup` if none found.
- **Never generate or guess an email address.** No `firstname.lastname@` pattern-guessing. Missing = `needs_lookup`.

**Step 3 — Dedup & persist.** Drop any candidate already in `leads` (by normalized name or website domain). Insert survivors as `status = 'new'` with their contacts.

**Robustness notes for the agent:** batch the work so a 50-lead request degrades gracefully (return what succeeds, report failures). Rate-limit and retry web-search calls. Show partial progress in the UI.

---

## 6. Tailoring Rules Engine (Section detail)

The operator tunes behavior in natural language; rules persist permanently and apply to all future generations.

**On rule submission:**
1. Send the `raw_instruction` to Claude with a parsing prompt that classifies it into a `rule_type` and emits a `structured_value` JSON the engine can apply deterministically.
2. Examples:
   - "Don't pull any leads from the UK" → `discovery_filter`, `{ "exclude_countries": ["United Kingdom"] }`
   - "No em-dashes in any outreach" → `copy_style`, `{ "forbid": ["em_dash"] }`
   - "Lean more academic, less political" → `copy_style`, `{ "tone": "academic", "deemphasize": ["political"] }`
   - "Prioritize universities and fintech conferences" → `targeting`, `{ "prioritize_types": ["university", "fintech_conference"] }`
3. Save it. Keep the raw text so the operator always sees what they asked for.

**On every Discover run:** apply all active `discovery_filter` + `targeting` rules to the search prompt and post-filter results.

**On every Draft generation:** inject all active `copy_style` rules into the system prompt. Enforce hard constraints (e.g. em-dash ban) with a **post-generation check** that strips/rewrites violations, since prompt instructions alone aren't reliable.

---

## 7. Outreach Generation (Section detail)

For a given lead + contact, generate a tailored email.

**Inputs to Claude:** lead name/type/description/website, `fit_rationale`, `suggested_topics`, contact name/role, and all active `copy_style` rules. Enable web search so Claude can pull current, specific details about the org/event.

**The email must:**
- Be specifically researched, not boilerplate. Reference something real and current about the institution/event.
- Propose 1–3 concrete talk topics tailored to that audience.
- Optionally include relevant links (articles, talks, stories) that support the pitch.
- Make a genuine, tailored case for why Jeff is the right speaker for *this* venue.
- Cover both framings: speaking *at an event* and speaking *at an institution*.
- Output structured: `{ subject, body }`.

**Hard rules:** obey all active `copy_style` rules. Run the post-generation style check (Section 6) before showing the draft. No fabricated facts about the org; if web search returns nothing usable, say so in the draft rather than inventing.

---

## 8. Gmail Integration (Section detail)

- Use **Gmail API via OAuth 2.0**, sending from Jeff's connected Google account.
- One-time OAuth connect flow in settings; store refresh token securely (Supabase, server-side only).
- **Send** uses `users.messages.send`. On success, store `gmail_message_id` + `gmail_thread_id` on the `outreach` row, set `status = 'sent'`, `sent_at = now()`, advance lead to `reached_out`, and log an `interaction`.
- On failure, set `outreach.status = 'failed'` and surface a retry.
- Scopes: `gmail.send` (and `gmail.readonly` only if you later want reply detection — out of scope for v1, note it but don't build it).

**Security:** all Gmail and Claude calls happen server-side (Next.js route handlers / server actions). Never expose tokens or API keys to the client.

---

## 9. Status Pipeline Logic

```
new ──draft+send──▶ reached_out ──▶ interested ──▶ booked ──▶ closed
                         │                            
                         └──────────────▶ not_interested
```

- Status is operator-editable at any point (manual override allowed).
- `booked` requires/opens the booking form.
- `is_recurring` bookings expose a **"Reach out again"** action that clones the lead into a fresh outreach cycle (new `outreach` draft) while preserving history.
- Every status change writes an `interactions` row.

---

## 10. Out of Scope (v1)

- Reply detection / inbox parsing.
- Relationship nurturing, scheduling, contracts, payment.
- Multi-user / roles / permissions beyond the single login.
- Analytics dashboards beyond the basic pipeline counts.

Note these in the README as planned-but-not-built so they aren't silently dropped.

---

## 11. Deliverables Checklist

- [ ] Next.js app (App Router, TypeScript, Tailwind) deployable to Vercel.
- [ ] Supabase schema migration for all tables in Section 3.
- [ ] Supabase Auth single-login gate.
- [ ] Discover engine (Claude + web search) with dedup and swappable `ContactResolver`.
- [ ] Tailoring rules engine with NL parsing + structured application + post-gen style enforcement.
- [ ] Outreach generation with research and style rules.
- [ ] Gmail OAuth + send, with logging.
- [ ] All pages in Section 4.
- [ ] Status pipeline + bookings + recurring re-outreach.
- [ ] `.env.example`, `README.md` with full setup (Supabase, Gmail OAuth, Claude key).

---

## 12. Environment Variables (`.env.example`)

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Claude
ANTHROPIC_API_KEY=

# Gmail OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# Optional contact-resolution provider (swappable)
CONTACT_RESOLVER=claude   # claude | hunter | apollo
HUNTER_API_KEY=
APOLLO_API_KEY=
```
