# Speaker Outreach CRM

A single-user web app to generate, send, and track speaking-engagement outreach
for Jeff Flake. It is a lightweight CRM plus an AI outreach engine:

1. **Discover** — generate batches of new, qualified speaking-engagement leads
   (with contact info) using Claude + web search, deduped against everything
   already in the system.
2. **Draft** — auto-draft a tailored, researched outreach email for any lead.
3. **Send** — review/edit the draft and send from Jeff's Gmail with one click
   (one-click _approve-and-send_; nothing is ever auto-sent).
4. **Track** — move leads through a pipeline: `new → reached_out → interested →
   booked → closed` (plus `not_interested`, `cant_pay`, `junk`).
5. **Tune** — a natural-language settings panel turns instructions like "Don't
   pull leads from the UK" or "No em-dashes" into structured rules the AI obeys
   on every future run.

**Stack:** Next.js (App Router, TypeScript) + Tailwind CSS · Supabase
(Postgres, Auth) · Anthropic Claude (`claude-opus-4-8` with the web-search tool)
· Gmail API (OAuth 2.0) · deployable to Vercel.

---

## Prerequisites

- Node.js 20+ (built and tested on Node 24)
- A [Supabase](https://supabase.com) project
- An [Anthropic API key](https://console.anthropic.com)
- A Google Cloud project with the Gmail API enabled (for sending)

---

## 1. Install

```bash
npm install
cp .env.example .env.local   # then fill in the values (see below)
```

---

## 2. Supabase

### Create the schema

Open your Supabase project → **SQL Editor** and run **both** migrations in
order:

1. [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) —
   core tables (`leads`, `contacts`, `outreach`, `bookings`, `tailoring_rules`,
   `interactions`) plus a single-row `gmail_connection` table for the Gmail
   refresh token, RLS, and policies so **only authenticated users** can
   read/write app data (`gmail_connection` is reachable only by the
   service-role key).
2. [`supabase/migrations/0002_voice_insights.sql`](supabase/migrations/0002_voice_insights.sql)
   — the Voice & Insights tables (`voice_profile`, `email_insights`,
   `processed_messages`) and a `scopes` column on `gmail_connection`.

> Using the Supabase CLI instead? `supabase db push` will apply both.

### Create the single operator account

This is a **single-user app** — there is no sign-up screen. Create one login in
Supabase → **Authentication → Users → Add user** (email + password, "Auto
confirm" on). That email/password is what you'll use on the `/login` page.

### Get your keys

Supabase → **Project Settings → API**:

- `NEXT_PUBLIC_SUPABASE_URL` — Project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — `anon` public key
- `SUPABASE_SERVICE_ROLE_KEY` — `service_role` secret key (server-only; never
  exposed to the browser)

---

## 3. Claude

Set `ANTHROPIC_API_KEY`. The app uses `claude-opus-4-8` with the built-in
web-search tool for lead discovery and outreach research. No extra setup needed.

---

## 4. Gmail OAuth

1. In the [Google Cloud Console](https://console.cloud.google.com): create (or
   pick) a project → **APIs & Services → Library** → enable **Gmail API**.
2. **APIs & Services → OAuth consent screen**: configure it (External is fine),
   and while it's in "Testing", add your operator Google account under **Test
   users**. Scopes used: `gmail.send` (send outreach), `gmail.readonly` (read
   the archive for Voice & Insights), `userinfo.email`, `openid`.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized redirect URIs**: add exactly the value you set for
     `GOOGLE_REDIRECT_URI`, e.g.
     - local: `http://localhost:3000/api/gmail/callback`
     - prod: `https://your-app.vercel.app/api/gmail/callback`
4. Copy the client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   and set `GOOGLE_REDIRECT_URI` to match the URI you registered.
5. Run the app, sign in, go to **Tailoring** → **Connect Gmail**, and authorize.
   The refresh token is stored server-side in `gmail_connection`.

> Sending uses `users.messages.send` from the connected account. Reply
> detection (`gmail.readonly`) is intentionally **not** built — see
> [Out of scope](#out-of-scope-v1).

---

## 5. Contact resolution (optional, swappable)

Contact emails are **never guessed**. There are two paths:

- **Discovery stream (free, no credits):** while leads stream in, only the
  public contact Claude surfaced during its web-search pass is stored. A lead
  with no public email lands as `needs_lookup` for a moment.
- **Enrich (paid, automatic per lead):** with auto-enrich on (the default),
  each new lead is immediately enriched: web-search models find up to seven
  people, one Hunter domain search fills gaps, and Hunter's per-person Email
  Finder runs for anyone still missing an email, including the contact
  discovery itself surfaced. The goal is that a net-new lead arrives sendable
  with no manual "Find email" clicks. The per-contact **"Find email via
  {provider}"** button and manual email field remain for the rare miss.

Configure the on-demand provider:

```
CONTACT_RESOLVER=claude   # default — no paid lookups; "Find email" is disabled, use manual entry
CONTACT_RESOLVER=hunter   # set HUNTER_API_KEY  (Free plan = 50 searches/month)
CONTACT_RESOLVER=apollo   # set APOLLO_API_KEY
```

The resolver is a small swappable interface
([`lib/contacts/resolver.ts`](lib/contacts/resolver.ts)): `getInlineContactResolver()`
is the free discovery path; `getContactResolver()` is the env-selected paid path
used by the on-demand action. Add a provider by implementing `ContactResolver`.

---

## 6. Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npm run start    # serve the production build
```

Sign in with the operator account, then **Discover** your first batch of leads.

---

## 7. Automated follow-ups

Every initial outreach that is sent starts a follow-up sequence for that
recipient: up to **three short nudges, sent as replies in the same Gmail
thread**, on a widening cadence of roughly **day 4, day 11, and day 21**
(weekends roll to Monday). The cadence lives in
[`lib/followups/cadence.ts`](lib/followups/cadence.ts) and reflects the
consensus of cold-outreach benchmarks: most replies come from the first two
follow-ups, each later touch earns fewer replies and more spam complaints, and
the curve flattens after three.

Each follow-up is written fresh at send time on the lower-cost model (no web
search): a different job per step (light bump → one new angle or a timing
question → graceful close), plain prose, no automation cliches, aware of the
earlier nudges so it never repeats itself. Style rules and the learned voice
apply as they do to initial outreach.

**A follow-up is never sent if** the thread already has a reply or bounce
(checked live against Gmail right before sending, not just from the last
scan), the lead has left the outreach stage (interested, booked, not
interested, junk…), the contact has no valid email, or the operator paused the
sequence. The lead's status advances to **Follow-up 1 / 2 / 3** as each goes
out, and every send, stop, pause, and resume is written to the activity log.

**Scheduling.** `vercel.json` registers a cron that hits
`/api/cron/followups` every weekday at 15:00 UTC (8am Arizona). Set
`CRON_SECRET` in the environment; Vercel sends it as a bearer token and the
route refuses to run without it. The Dashboard also has a **Send due
follow-ups** button for running today's batch by hand (or on a host without
cron), and each lead page shows its sequences with pause / resume / send-now.
Trigger it manually with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/followups
```

Apply `supabase/migrations/0020_followups.sql` before using this.

- **Discover → ready to send** — with "Find contacts and draft outreach"
  checked (default), the Discover page calls `enrichLead` for each lead the
  moment it streams in: `findMultipleContacts` (web-search models, one Hunter
  domain search, then a per-person Hunter lookup for anyone still without an
  email, 7-contact cap) followed by
  `draftForAllContacts` (one personalized draft per contact with an email).
  Two leads are enriched at a time; each call is one lead so it stays inside
  function limits. The Leads bulk bar has the same action as
  "Find Contacts + Draft".
- **Throttled bulk send** → select leads (shift-click selects a range) and
  press "Send Drafts", choosing a spread (15 min to 2 hours). Drafts are
  marked `queued` with a `scheduled_for` time, at least 20s apart with jitter
  (`lib/outreach/send.ts`). The Leads page drains due emails every 20s while
  open; `/api/cron/send-queue` (daily at 16:00 UTC in `vercel.json`, the most the
  Hobby plan allows; on Pro you can change it to `*/10 * * * *`) catches
  anything left over. A rolling
  cap of 300 sends per 24h applies. "Cancel remaining" returns queued emails
  to draft. Apply `supabase/migrations/0022_send_queue.sql` first.
- **Who sent it** → `outreach.sent_via` (`app` | `gmail`). The app writes `app`
  at send time; outreach sent by hand from the inbox and imported later is
  `gmail`. The Leads list shows a "Sent by" column and filter, and the lead
  header shows the badge for the earliest sent outreach, because commission
  follows whoever started the conversation. Apply
  `supabase/migrations/0021_outreach_sent_via.sql` first; it also back-fills
  the imported fall 2026 campaign as `gmail`.
- **Where the Claude bill goes** → every Claude call writes one row to
  `api_usage` (feature, model, input/output/cache tokens, web-search count,
  duration, ok/error) so spend can be attributed to discovery vs drafting vs
  contact finding. Logging is best-effort and never fails the call. Apply
  `supabase/migrations/0025_api_usage.sql` first; until then each call logs a
  warning and continues. Models (`lib/claude/client.ts`): Opus 5.5 for
  discovery and outreach drafting, Sonnet 5 for everything else, Haiku 5.5
  for reply classification.
- **No repeated paid lookups** → `contacts.email_lookup_attempted_at` records
  when Hunter was asked about a person. The enrich pass sets it for every
  contact it tried, and "Find email via hunter" refuses to repeat a lookup
  that was already made (the button becomes "Check hunter again anyway").
  Apply `supabase/migrations/0023_contact_lookup_attempted.sql` **before**
  deploying this; contact inserts write the column.

---

## 8. Engagement guard (never email an org we're already talking to)

Before any email leaves the app, [`lib/outreach/guard.ts`](lib/outreach/guard.ts)
resolves the **organization** behind the lead and refuses to send if that
organization is already in a conversation, wherever that conversation lives:

1. **Same org, different lead row.** Leads that share a registrable domain
   (website or any contact's institutional email) or whose normalized names
   contain one another are treated as one organization. "Trinity University"
   and "Trinity University Distinguished Lecture Series" are the same school.
2. **CRM signals across the whole org:** a lead that is Interested, Booked,
   Closed, Closed (Not Me), Not interested, or Can't pay; any recorded reply; any
   outreach that was sent by hand from Gmail and imported.
3. **Live mailbox check:** any human reply from the domain in the last year
   (bounces and out-of-office auto-replies don't count), or any email to the
   domain that this app did not send (Jeff or Cheryl reached out by hand).

The guard runs in the single send path (`sendOutreachRow`), so it covers
one-click sends, "send all", the throttled queue, and the cron drainer. It
also runs before every automated follow-up, so a reply from one person at a
school stops the nudges to their colleagues. It **fails closed**: if Gmail
can't be checked, nothing is sent and queued rows wait.

A refused email is parked as **Blocked** with the reason, and a red banner on
the lead page lists every conflict with links to the sibling lead. Nothing
retries it automatically. The only way to send anyway is the operator's
**Override & send** on that one draft, which requires a typed reason that is
stored on the row and written to the Activity log. "Reach out again" on a
recurring venue sets that override up front, since re-engaging is the point.

Migration: [`supabase/migrations/0024_engagement_guard.sql`](supabase/migrations/0024_engagement_guard.sql)
adds the `blocked` status and the override columns. Until it is applied the
guard still refuses to send; it just records the refusal as `failed` with a
`BLOCKED:` prefix and overrides can't be saved.

## Deploying to Vercel

1. Push the repo and import it in Vercel.
2. Add every variable from `.env.example` in **Project → Settings →
   Environment Variables**.
3. Set `GOOGLE_REDIRECT_URI` to `https://<your-domain>/api/gmail/callback` and
   add that same URI to the Google OAuth client's Authorized redirect URIs.
4. (Optional) set `NEXT_PUBLIC_APP_URL` to your production URL.
5. Set `CRON_SECRET` (any long random string) so the follow-up cron can run.

**Function duration:** Discovery and outreach make long web-search calls. The
`/discover` and `/leads/[id]` routes declare `maxDuration = 300`. This is honored
on Vercel **Pro/Enterprise**; on the **Hobby** plan functions are capped (~60s),
so on Hobby request smaller discovery batches (e.g. 10–20) to stay within the
limit. Locally there is no such cap.

---

## How it works

- **Discover** (`/discover`) → [`lib/claude/discovery.ts`](lib/claude/discovery.ts):
  prompts Claude (web search) for real, sourced venues in chunks (degrades
  gracefully — returns what succeeds), applies active `discovery_filter` /
  `targeting` rules in the prompt _and_ as a post-filter, dedups against the DB
  by normalized name and registrable domain (website or any existing
  contact's institutional email), resolves a contact per lead, and inserts
  survivors as `new`.
- **Draft & send** → [`lib/claude/outreach.ts`](lib/claude/outreach.ts): a
  researched, tailored email (subject + body) honoring active `copy_style`
  rules, with a deterministic post-generation style check
  ([`lib/claude/style.ts`](lib/claude/style.ts)) that strips/rewrites hard
  violations (e.g. em-dashes) since prompt instructions alone aren't reliable.
  Approve & Send goes out via the Gmail API, logs the message/thread IDs,
  advances the lead to `reached_out`, and records an activity entry.
- **Tailoring** (`/settings/tailoring`) →
  [`lib/claude/rules.ts`](lib/claude/rules.ts): each natural-language
  instruction is parsed into a structured rule (`rule_type` + `structured_value`)
  that persists and applies to all future runs. The raw text is always kept so
  you see exactly what you asked for.
- **Pipeline**: status is operator-editable at any point. `booked` opens a
  booking form; recurring bookings expose **Reach out again**, which spins up a
  fresh outreach draft while preserving history. Every status change is logged.
- **Voice & Insights** (`/voice-insights`) →
  [`lib/gmail/ingest.ts`](lib/gmail/ingest.ts) +
  [`lib/claude/voice.ts`](lib/claude/voice.ts): connect Gmail read-only, then
  **Run analysis** ingests the archive (SENT-prioritized, paginated list +
  batched get, quoted replies/signatures stripped) and runs a multi-pass Claude
  analysis (voice, tactics, structure, cadence) that synthesizes an active
  `voice_profile`. Its condensed `prompt_injection` is injected into **every**
  outreach generation (operator `tailoring_rules` win on conflict), and the run
  surfaces suggested rules for one-click acceptance into Tailoring.
  **Re-analyze** processes only new messages (deduped by ID via
  `processed_messages`).

### Voice & Insights — scope, privacy, and v2

- **Read-only by design.** The feature adds the `gmail.readonly` scope purely to
  analyze the archive. After upgrading from the send-only base app you must
  **reconnect Gmail once** to grant read access — the tab detects this and shows
  a "Reconnect with read access" prompt.
- **Privacy.** Raw email bodies are fetched server-side, analyzed, and
  **discarded** — they are never persisted. Only the distilled summaries, short
  example excerpts (from Jeff's own sent writing), and processed message IDs are
  stored. Nothing is logged client-side. Confirm Jeff is comfortable having the
  full archive analyzed before running it — it contains third parties' private
  replies.
- **Planned but not built (v2):** automatic/scheduled background Gmail sync,
  reply-thread conversation modeling (multi-turn intelligence), and real-time
  ingestion of new mail. App-sent outreach isn't re-scraped from Gmail — that
  data already lives in the `outreach`/`interactions` tables. This feature is
  intentionally manual and operator-triggered.

---

## Out of scope (v1)

These are intentionally **not** built (noted here so they aren't silently
dropped):

- Live reply detection / inbox parsing for sent outreach. (Voice & Insights
  does read the archive read-only for analysis, but real-time reply-thread
  intelligence is still out — see its v2 notes above.)
- Relationship nurturing, scheduling, contracts, payment.
- Multi-user / roles / permissions beyond the single login.
- Analytics beyond the basic pipeline counts.

---

## Project layout

```
app/
  (app)/                     authed shell + pages (dashboard, leads, discover, settings)
  actions/                   server actions (auth, discover, outreach, leads, rules, gmail)
  api/gmail/                 OAuth connect + callback route handlers
  login/                     login page
components/                  client + presentational UI
lib/
  claude/                    discovery, outreach, rule parsing, style, voice analysis, client
  contacts/                  swappable ContactResolver (claude | hunter | apollo)
  gmail/                     OAuth, token storage, send, archive ingestion
  supabase/                  server / admin / proxy-session clients
  data.ts                    server-side reads
  types.ts, utils.ts, env.ts
supabase/migrations/         SQL schema
proxy.ts                     auth gate (Next 16 proxy convention)
```

---

## Security notes

- All Claude, Gmail, and service-role calls happen **server-side only**
  (route handlers / server actions). Tokens and API keys are never exposed to
  the client.
- The whole app is gated behind one Supabase Auth login via `proxy.ts`.
- The Gmail refresh token lives in `gmail_connection`, which has no
  authenticated-role RLS policy — only the service-role key can read it.
- Emails are never fabricated; unresolved contacts are surfaced as
  `needs_lookup` with a prompt to find the address manually.
