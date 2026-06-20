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
   booked → closed` (plus `not_interested`).
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

Open your Supabase project → **SQL Editor** and run the migration in
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). It
creates all tables (`leads`, `contacts`, `outreach`, `bookings`,
`tailoring_rules`, `interactions`) plus a single-row `gmail_connection` table
for the Gmail refresh token, enables Row Level Security, and adds policies so
**only authenticated users** can read/write app data. The `gmail_connection`
table is reachable only by the service-role key.

> Using the Supabase CLI instead? `supabase db push` will apply the migration.

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
   users**. Scopes used: `gmail.send`, `userinfo.email`, `openid`.
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

Discovery finds a public contact email via Claude + web search by default and
**never guesses** addresses — if none is found the contact is stored as
`needs_lookup` and flagged in the UI.

To plug in a dedicated email-finding API later, set `CONTACT_RESOLVER` and the
matching key:

```
CONTACT_RESOLVER=claude   # default
CONTACT_RESOLVER=hunter   # set HUNTER_API_KEY
CONTACT_RESOLVER=apollo   # set APOLLO_API_KEY
```

The resolver is a small swappable interface
([`lib/contacts/resolver.ts`](lib/contacts/resolver.ts)); add a new provider by
implementing `ContactResolver` and wiring it into `getContactResolver()`.

---

## 6. Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npm run start    # serve the production build
```

Sign in with the operator account, then **Discover** your first batch of leads.

---

## Deploying to Vercel

1. Push the repo and import it in Vercel.
2. Add every variable from `.env.example` in **Project → Settings →
   Environment Variables**.
3. Set `GOOGLE_REDIRECT_URI` to `https://<your-domain>/api/gmail/callback` and
   add that same URI to the Google OAuth client's Authorized redirect URIs.
4. (Optional) set `NEXT_PUBLIC_APP_URL` to your production URL.

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
  by normalized name and website domain, resolves a contact per lead, and
  inserts survivors as `new`.
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

---

## Out of scope (v1)

These are intentionally **not** built (noted here so they aren't silently
dropped):

- Reply detection / inbox parsing (would need the `gmail.readonly` scope).
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
  claude/                    discovery, outreach, rule parsing, style enforcement, client
  contacts/                  swappable ContactResolver (claude | hunter | apollo)
  gmail/                     OAuth, token storage, send
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
