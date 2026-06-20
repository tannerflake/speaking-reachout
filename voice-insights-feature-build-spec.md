# Voice & Insights — Feature Build Spec

**Purpose:** Analyze Jeff's existing outreach email history to learn his voice, his proven tactics, and what correlates with bookings, then feed that into the app's draft engine so generated outreach sounds like him and uses what works.

**Context:** This is an add-on feature for the existing Speaker Outreach CRM (Next.js + Supabase + Vercel, Gmail OAuth, Claude API). It assumes that app already exists. Build this as a new tab + supporting tables + analysis pipeline.

---

## 0. Build Directives for the Coding Agent

- This feature has **two distinct jobs. Do not merge them.**
  1. **Bootstrap analysis:** run once against the full email archive (~618 messages) to distill a voice profile and seed tailoring rules.
  2. **Incremental re-analysis:** a "Re-analyze" action that processes only new messages since the last run (dedup by message ID).
- **Out of scope for v1** (note in README as planned, do not build): automatic/scheduled background sync, reply-thread conversation intelligence, real-time ingestion. Keep this a manual, operator-triggered feature.
- Add `gmail.readonly` to the OAuth scopes (the base app only had `gmail.send`).
- The analysis output feeds the **existing draft engine**: the `voice_profile` record is injected into the outreach generation system prompt, and seed rules land in the existing `tailoring_rules` table.
- All Gmail and Claude calls are **server-side only**. Never expose tokens or keys to the client.
- Keep the raw email archive **local/private**. It contains third-party contact info and private replies. Do not send raw third-party emails anywhere public or log them client-side.

---

## 1. What We're Building (Plain Language)

Jeff has ~618 emails in the account he's used for outreach. His sent mail is the gold: it's his real voice, his real pitch structure, and the threads that led to bookings show what actually works.

This feature:
1. Connects to that Gmail account (read-only).
2. Pulls the message history (sent + received).
3. Runs a multi-pass AI analysis: voice/tone, winning tactics, message structure, follow-up cadence.
4. Stores the result as a readable insights view **and** as a structured `voice_profile` the draft engine uses on every generation.
5. Seeds the `tailoring_rules` table with concrete rules derived from his actual patterns.
6. Can be re-run later to fold in new messages without reprocessing the whole archive.

---

## 2. Core Flows

### Flow A — Bootstrap Analysis (run once)
1. Operator opens the **Voice & Insights** tab and connects the Gmail account (read-only OAuth).
2. Clicks **Run Analysis**.
3. App fetches all messages (sent + received), prioritizing `SENT`.
4. App runs the multi-pass analysis (Section 5).
5. Results render on the tab. A `voice_profile` row is written/updated. Suggested seed rules are presented for the operator to **accept into** `tailoring_rules` (one click each, or accept all).
6. Processed message IDs are recorded so re-runs skip them.

### Flow B — Re-analyze (incremental)
1. Operator clicks **Re-analyze**.
2. App fetches only messages whose IDs aren't in `processed_messages`.
3. If there are new messages, it re-runs analysis incorporating them and updates the `voice_profile` (versioned, see Section 3).
4. If nothing new, it says so and does nothing.

---

## 3. Data Model Additions (Supabase / Postgres)

### `voice_profile`
Single active profile (keep history via versioning).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| version | int | Increment on each regeneration |
| is_active | boolean | Only one active at a time |
| tone_summary | text | Human-readable description of his voice |
| structure_summary | text | How he structures a pitch (opening, ask, close) |
| tactics_summary | text | What correlates with positive replies/bookings |
| cadence_summary | text | Follow-up timing and persistence patterns |
| prompt_injection | text | The condensed block injected into the draft engine system prompt |
| source_message_count | int | How many emails this was built from |
| created_at | timestamptz | |

### `processed_messages`
Dedup tracking so re-analysis only ingests new mail.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| gmail_message_id | text UNIQUE | |
| label | text | `SENT` \| `INBOX` \| other |
| internal_date | timestamptz | Gmail message date |
| processed_at | timestamptz | |

### `email_insights` (optional, for the readable tab view)
Stores the distilled findings for display. Can be folded into `voice_profile` if you prefer fewer tables; separate is cleaner for rendering.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| voice_profile_id | uuid FK → voice_profile | |
| category | text | `voice` \| `tactics` \| `structure` \| `cadence` |
| insight | text | A single distilled finding |
| example_excerpt | text | Short supporting snippet from his mail, nullable |
| created_at | timestamptz | |

**Note:** seed rules derived from analysis are written into the **existing** `tailoring_rules` table, not a new one. Tag them (e.g. `structured_value.origin = "voice_analysis"`) so they're distinguishable from manually entered rules.

---

## 4. Email Ingestion (Section detail)

**Engine:** Gmail API, read-only.

- Add scope `https://www.googleapis.com/auth/gmail.readonly`.
- Fetch flow: `users.messages.list` (paginated) to get IDs, then batch `users.messages.get` for each.
- For each message capture: `id`, `threadId`, labels, internal date, headers (From, To, Cc, Subject), and the body (prefer plain text; strip quoted reply chains and signatures where feasible so analysis sees the actual writing).
- **Prioritize `SENT`** mail in analysis weighting. His sent messages are the primary voice signal; received messages are context (especially replies that indicate interest or a booking).
- On bootstrap, ingest everything. On re-analyze, skip any `gmail_message_id` already in `processed_messages`.
- ~618 messages is small. No need for background jobs or queues; a single server-side request with pagination and progress reporting is fine. Show progress in the UI.

**Privacy:** keep raw bodies server-side. Store only what's needed (the `voice_profile` summaries + short example excerpts). Do not persist full third-party email bodies long-term if avoidable; analyze, distill, discard the raw.

---

## 5. Analysis Pipeline (Section detail)

**Engine:** Claude API. Do **not** stuff 618 emails into one prompt. Run focused passes, then synthesize.

### Step 1 — Filter & segment
- Separate `SENT` (his writing) from received.
- Identify "success" threads: threads that reached a positive reply or a booking. If the base app has booking data, cross-reference; otherwise infer from reply sentiment.

### Step 2 — Multi-pass analysis
Run these as separate Claude calls (each gets a relevant slice of the corpus), then combine:

1. **Voice & tone pass.** Input: a representative sample of his sent emails. Output: how he writes. Formality, warmth, sentence length, vocabulary, signature phrases, what he avoids. Capture concrete markers, not vibes.
2. **Tactics pass.** Input: success threads vs non-response threads. Output: what his winning emails do differently. Openings, the specific ask, personalization depth, use of credibility/links, length.
3. **Structure pass.** Output: the skeleton of his typical pitch. How he opens, sequences the case, makes the ask, closes.
4. **Cadence pass.** Output: follow-up behavior. How long he waits, how many touches, how follow-ups differ in tone from first contact.

### Step 3 — Synthesize
- Combine the four passes into one `voice_profile` record: the four summaries plus a **condensed `prompt_injection` block** (tight, high-signal, the thing the draft engine actually reads on every generation).
- Generate a set of **suggested tailoring rules** in the existing rule format (e.g. `copy_style`: "open with a specific reference to the institution, never a generic greeting"; `copy_style`: "keep first-contact emails under 180 words"). Present for operator approval.
- Populate `email_insights` rows for the readable tab.

### Step 4 — Persist
- Write the new `voice_profile` (increment version, set active, deactivate prior).
- Record all processed `gmail_message_id`s.
- Surface suggested rules for one-click acceptance into `tailoring_rules`.

---

## 6. Integration with the Draft Engine (Section detail)

- The existing outreach generation step (from the base app spec) must **inject the active `voice_profile.prompt_injection`** into its system prompt, alongside the active `tailoring_rules`.
- Order of precedence if there's ever conflict: explicit operator `tailoring_rules` override the learned `voice_profile`. (The operator's stated wishes beat inferred patterns.)
- This is the payoff: from the first draft, generated outreach sounds like Jeff and uses his proven moves.

---

## 7. UI — `/voice-insights` Tab

- **Connection state:** connect Gmail (read-only) if not already; show connected account.
- **Run Analysis / Re-analyze** button with progress state.
- **Insights view:** the four categories (voice, tactics, structure, cadence) rendered readably, with example excerpts.
- **Suggested rules:** list with **Accept** (one click → writes to `tailoring_rules`) and **Accept all**.
- **Profile status:** current version, source message count, last run date.
- **Empty state:** "No analysis yet. Connect the account and run analysis to teach the app Jeff's voice."

---

## 8. Out of Scope (v1)

- Automatic / scheduled background Gmail sync.
- Reply-thread conversation modeling (multi-turn back-and-forth intelligence).
- Real-time ingestion of new mail as it arrives.
- Analyzing app-sent outreach via Gmail (that data already lives natively in the `outreach` / `interactions` tables; analyze it from there if needed, don't re-scrape).

Note these in the README as planned-but-not-built.

---

## 9. Deliverables Checklist

- [ ] `gmail.readonly` added to OAuth scopes.
- [ ] Supabase migration: `voice_profile`, `processed_messages`, `email_insights`.
- [ ] Gmail ingestion (paginated list + batch get, SENT-prioritized, dedup against `processed_messages`).
- [ ] Multi-pass Claude analysis (voice, tactics, structure, cadence) + synthesis.
- [ ] Writes active `voice_profile` with condensed `prompt_injection`.
- [ ] Suggested seed rules surfaced for one-click acceptance into existing `tailoring_rules`.
- [ ] Draft engine updated to inject active `voice_profile.prompt_injection`.
- [ ] `/voice-insights` tab with run/re-analyze, insights view, suggested rules, profile status.
- [ ] README notes: read-only scope rationale, privacy handling of raw mail, v2 scope.

---

## 10. Notes for the Operator (not the agent)

- You can run a manual analysis **today** (IMAP export + a Claude pass) to get a seed voice profile immediately, in parallel with this being built. The tab's job is to make it repeatable and self-serve, not to be the only path.
- Confirm Jeff is good with the full archive being pulled and analyzed. It's his correspondence and contains other people's private replies.
