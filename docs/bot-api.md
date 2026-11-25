# Bot import API (`/api/bot/v1`)

Jeff's grooming bot (a separate AI agent with Gmail access to
cheryl@jeffflake.com, cherylflake@gmail.com and Jeff's personal inbox) uses
this API to add or update a complete lead in one call, append correspondence
from any inbox, and record engagements (bookings) by year. The CRM no longer
depends on the "Scan email for updates" button to know about those
conversations.

Base URL: `https://www.jeffflake.com/api/bot/v1`

Code: `app/api/bot/v1/**`, `lib/bot/*` (auth, validation, matching, writes).
Schema: `supabase/migrations/0037_bot_api_and_engagements.sql`.

## Auth

```
Authorization: Bearer $JEFF_CRM_BOT_KEY
X-Bot-Name: grooming-bot        # optional; defaults to the key's label
Content-Type: application/json  # for POST
```

* Keys look like `jfb_` + 43 url-safe characters. Generate, rotate and revoke
  them in **Settings > Bot access** (`/admin/settings/bot-access`). The raw key
  is shown once; only its sha256 is stored.
* Any missing, unknown or revoked key gets `401 {"error":"unauthorized"}` with
  no further detail.
* Every authenticated request (success or failure) is logged in
  `bot_activity` and shown on the Bot access page. Writes are attributed to
  `bot:<name>` in the lead's activity log (`interactions.actor`), together
  with the source inbox.
* Keep the key out of the repo: the operator stores it in `.bot-api-key.txt`
  (git-ignored) or the bot's own secret store.

## Errors

All responses are JSON. Errors look like `{"error": "<code>", ...}`:

| Status | error | When |
|---|---|---|
| 400 | `invalid_json` | body is not JSON |
| 400 | `validation_failed` | `fields: [{path, message}]` lists every problem |
| 401 | `unauthorized` | bad / revoked key |
| 404 | `lead_not_found` | unknown lead id |
| 409 | `lead_blocked` | status change away from `blocked` (never allowed) |
| 413 | `too_many_messages` / `too_many_contacts` / `too_many_engagements` | over 200 messages / 50 contacts / 100 engagements per call |
| 500 | `internal_error` | unexpected; no stack trace is returned |

## Rules the API enforces

* **Never sends anything.** No route sends, queues or drafts email, starts a
  follow-up sequence, runs contact finding / enrichment / discovery, or calls
  Claude. Status is written straight to the database.
* **Stopping is allowed, starting is not.** Changing status to `interested`,
  `back_burner`, `booked`, `closed`, `closed_not_me`, `not_interested`,
  `cant_pay`, `junk` or `blocked` stops the lead's active follow-ups
  (`stop_reason: "bot status change: <status>"`). A human (non-automated)
  inbound message dated after an active sequence started stops follow-ups to
  everyone at that organization, as the reply scanner does.
* **Blocked is sticky.** The bot can never move a lead out of `blocked`
  (status endpoint: 409; upsert: status kept, warning
  `"lead is blocked; status unchanged"`). Logging messages to a blocked lead
  is fine.
* **Status never changes implicitly.** Inbound messages never change status;
  only `lead.status` in an upsert or the status endpoint do.
* **Merges are followed everywhere.** Any id of a merged duplicate resolves to
  the surviving lead (`merged_into_id`); responses include `merged_from`.
* **Idempotent correspondence.** A message is skipped as a duplicate when a
  row already has the same `(source_inbox, gmail_message_id)`, the same
  `rfc822_message_id` (the same email seen in two inboxes), or, for outbound
  mail, an outreach row already has that `gmail_message_id`. Re-sending the
  exact same upsert writes nothing new (apart from the `bot_activity` row).
* **Outbound messages** also create an outreach row (`status: sent`,
  `sent_via` from the message, default `gmail`) so the "already contacted"
  engagement guard and commission attribution see them. Bot-logged mail with
  the default `sent_via: "gmail"` does **not** count as "Sent via app". These
  rows are never queued and never get a follow-up sequence, so the send queue
  and follow-up runner never act on them.
* **Inbound messages** set `replied_at` on the outreach they answer (same
  Gmail thread, or same contact, sent earlier). If the lead has a future
  revisit date and the reply is dated after the last status/revisit change,
  the revisit date and note are cleared (same helper as the reply scanner),
  unless this same call set the revisit explicitly.
* **Contacts.** Message counterparties are added as contacts automatically
  (inbound: the sender, `verified`; outbound: to/cc recipients,
  `unverified`). Flake-side addresses are never contacts: any
  `@jeffflake.com`, `cherylflake@gmail.com`, and the comma-separated env var
  `BOT_OWN_ADDRESSES` (set this to Jeff's personal address). An address that
  already belongs to a different lead is never copied; you get a warning.
* **Field updates never blank by omission.** Only fields you send are set.
  `null` clears only `revisit_on`, `revisit_note` and `attribution_override`.
* **Inquiry leads** (`kind: "inquiry"`) stay out of outreach and automation as
  elsewhere in the CRM. Reclassifying a lead to `inquiry` stops its follow-ups
  and returns scheduled emails to draft.
* **`dry_run: true`** runs all matching and dedupe and returns what would
  change, writing nothing except the `bot_activity` row (summary prefixed
  `DRY RUN`).

## Shapes

### MESSAGE

```json
{
  "direction": "inbound",                     // required: inbound | outbound
  "from_email": "jane@harvard.edu",           // required
  "from_name": "Jane Smith",
  "to": ["cheryl@jeffflake.com"],             // required
  "cc": [],
  "sent_at": "2026-11-20T15:04:00Z",          // required ISO datetime
  "subject": "Re: Speaking at the IOP",
  "body": "Full plain text (stored up to 100k chars)",
  "snippet": "Short preview",
  "gmail_message_id": "18c2f...",
  "gmail_thread_id": "18c2e...",
  "rfc822_message_id": "<CAF=abc@mail.gmail.com>",
  "source_inbox": "cherylflake@gmail.com",    // defaults to the request's source_inbox
  "sent_via": "gmail"                         // gmail (default) | app
}
```

### ENGAGEMENT

```json
{
  "id": "uuid of an existing booking (update)",
  "event_name": "Harvard IOP Forum",          // required on create
  "event_date": "2025-04-10",                 // YYYY-MM-DD
  "event_end_date": "2025-04-11",
  "event_year": 2025,                         // required if no event_date
  "fee": 25000,
  "topic": "Civility in politics",
  "location": "Cambridge, MA",
  "outcome": "completed",                     // completed | upcoming | canceled (DB derives it if omitted)
  "is_recurring": false,
  "notes": "Free text"
}
```

Engagement upsert matching on a lead: `id` -> same `event_date` -> same
`event_year` + same `event_name` (case-insensitive). New rows get
`source: "bot_import"` and `source_inbox`. Engagements never change lead
status.

## Endpoints

### `GET /me`

Key check.

```bash
curl -s https://www.jeffflake.com/api/bot/v1/me \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY"
```

```json
{"ok": true, "bot_name": "Jeff's bot", "key_label": "Jeff's bot", "key_prefix": "jfb_AbC123"}
```

### `GET /leads/search?domain=&email=&name=&q=&limit=`

* `email`: exact (case-insensitive) on contacts, and on correspondence
  from/to.
* `domain`: registrable domain of contact emails or the lead's website
  (`www.` stripped, subdomains included). Personal providers (gmail.com,
  yahoo.com, outlook.com, hotmail.com, icloud.com, aol.com, me.com, msn.com,
  comcast.net, live.com, ...) are ignored.
* `name`: contains, or normalized-name contains.
* `q`: treated as an email, a domain or a name depending on its shape.
* `limit`: default 20, max 50. Criteria are OR'd; results sorted by last
  activity.

```bash
curl -s "https://www.jeffflake.com/api/bot/v1/leads/search?domain=harvard.edu" \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY"
```

```json
{
  "ok": true,
  "count": 1,
  "results": [{
    "id": "6f1c...", "name": "Harvard Institute of Politics", "website": "https://iop.harvard.edu",
    "status": "interested", "kind": "speaking", "inquiry_type": null,
    "merged_into_id": null, "resolved_lead_id": "6f1c...",
    "contacts": [{"name": "Jane Smith", "email": "jane@harvard.edu", "role": "Program Director"}],
    "last_activity": "2026-11-20T15:10:02Z",
    "engagement_years": [2023, 2025]
  }],
  "warnings": []
}
```

### `GET /leads/:id[?bodies=1]`

Full lead (merges resolved; `merged_from` set when redirected): lead fields
(status, revisit, attribution override, kind, inquiry type), contacts (phone,
OOO, referred by), the newest 200 messages (bodies only with `?bodies=1`),
sent outreach (channel, dates, Gmail ids), engagements, the last 50 activity
entries, `engagement_years`, and `counts_as_app` (whether the conversation
counts as started by the app, per the attribution rules).

```bash
curl -s "https://www.jeffflake.com/api/bot/v1/leads/6f1c...?bodies=1" \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY"
```

### `POST /leads/upsert`

Add or update a complete lead in one call.

```json
{
  "source_inbox": "cherylflake@gmail.com",
  "dry_run": false,
  "match": {"lead_id": null, "domain": "harvard.edu", "email": "jane@harvard.edu"},
  "lead": {
    "name": "Harvard Institute of Politics",
    "website": "https://iop.harvard.edu",
    "type": "institution",
    "location_country": "United States",
    "location_region": "Massachusetts",
    "status": "interested",
    "status_reason": "Jane asked for spring 2027 dates",
    "revisit_on": "2027-01-15",
    "revisit_note": "Confirm spring date",
    "kind": "speaking"
  },
  "contacts": [
    {"email": "jane@harvard.edu", "name": "Jane Smith", "role": "Program Director", "phone": "+1 617 555 0100"},
    {"email": "bob@harvard.edu", "name": "Bob Lee", "referred_by_email": "jane@harvard.edu"}
  ],
  "messages": [ /* MESSAGE ... */ ],
  "engagements": [ /* ENGAGEMENT ... */ ],
  "note": "Imported from Cheryl's Gmail thread 'Speaking at the IOP'"
}
```

Lead resolution order: `match.lead_id` -> exact contact email (any
`contacts[].email`, `match.email`, or any non-Flake address in `messages`) ->
domain (`match.domain`, website host, non-generic contact email domains) ->
exact normalized name. With several candidates the API picks the one that is
not junk with the most recent activity and lists the others in
`ambiguous_candidates`. With no match it creates the lead
(`source: "bot_import"`; `lead.name` required; status defaults to `new`, or
`reached_out` when there are outbound messages; `interested` only if you send
it; kind defaults to `speaking`).

Response:

```json
{
  "ok": true,
  "dry_run": false,
  "lead_id": "6f1c...",
  "created": false,
  "matched_by": "email",
  "status": "interested",
  "changes": ["status reached_out -> interested", "revisit none -> 2027-01-15", "5 message(s) logged", "2 contact(s) added"],
  "messages": {"logged": 5, "duplicates": 1},
  "contacts": {"added": 2, "updated": 0},
  "engagements": {"added": 1, "updated": 0},
  "warnings": []
}
```

```bash
curl -s -X POST https://www.jeffflake.com/api/bot/v1/leads/upsert \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY" \
  -H "X-Bot-Name: grooming-bot" \
  -H "Content-Type: application/json" \
  -d @upsert.json
```

Tip: send `"dry_run": true` first for a new kind of payload.

### `POST /leads/:id/messages`

Append correspondence to an existing lead (merges resolved).

```json
{"source_inbox": "jeff@example.com", "dry_run": false, "messages": [ /* MESSAGE ... */ ]}
```

Response: `{ok, lead_id, messages: {logged, duplicates}, contacts: {added, updated}, changes, warnings}`.

```bash
curl -s -X POST https://www.jeffflake.com/api/bot/v1/leads/6f1c.../messages \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY" -H "Content-Type: application/json" \
  -d '{"source_inbox":"cherylflake@gmail.com","messages":[{"direction":"inbound","from_email":"jane@harvard.edu","to":["cherylflake@gmail.com"],"sent_at":"2026-11-21T17:00:00Z","subject":"Re: dates","snippet":"April works for us","gmail_message_id":"18c3..."}]}'
```

### `POST /leads/:id/status`

```json
{"source_inbox": "cherylflake@gmail.com", "status": "back_burner", "reason": "Budget reopens in the fall", "revisit_on": "2027-08-01", "revisit_note": "Ask about fall series", "dry_run": false}
```

`reason` is required. 409 `lead_blocked` if the lead is blocked. Activity
entry: `"<old> -> <new> (bot, from <inbox>): <reason>"`.

```bash
curl -s -X POST https://www.jeffflake.com/api/bot/v1/leads/6f1c.../status \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY" -H "Content-Type: application/json" \
  -d '{"source_inbox":"cherylflake@gmail.com","status":"booked","reason":"Contract signed for April 10"}'
```

### `GET /leads/:id/engagements` and `POST /leads/:id/engagements`

GET lists the lead's engagements and `engagement_years`. POST upserts:

```json
{"source_inbox": "cherylflake@gmail.com", "dry_run": false, "engagements": [
  {"event_name": "Harvard IOP Forum", "event_date": "2025-04-10", "fee": 25000, "outcome": "completed"},
  {"event_name": "Harvard IOP Forum", "event_year": 2027, "outcome": "upcoming"}
]}
```

```bash
curl -s https://www.jeffflake.com/api/bot/v1/leads/6f1c.../engagements \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY"
```

### `GET /engagements?year=2025&outcome=completed&limit=`

All engagements (any lead, merged-away leads excluded) with `lead_name`,
`lead_status`, `lead_kind`. Answers "what did Jeff do in 2025". `limit`
default 500, max 1000.

```bash
curl -s "https://www.jeffflake.com/api/bot/v1/engagements?year=2025" \
  -H "Authorization: Bearer $JEFF_CRM_BOT_KEY"
```

## In the CRM

* Leads list: "Booked 2025" chips on each lead row (dashed "upcoming" style
  for years not yet happened), a **Booked year** filter (`?booked=2025` or
  `?booked=past`), and an "Imported by bot" source.
* Lead page: year chips beside the status, an **Engagements** section
  (add / edit / delete, year required when the date is unknown, outcome), a
  **Correspondence** section with every imported message, and activity
  entries tagged with the bot's name and source inbox.
* Settings > Bot access: keys and the last 50 API calls.
