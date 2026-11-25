// Domain + database row types. Kept hand-written (small schema) rather than
// generated, so the app has a single source of truth for shapes.

export type LeadType = "event" | "institution" | "other";

export type LeadStatus =
  | "new"
  | "blocked"
  | "reached_out"
  | "followup_1"
  | "followup_2"
  | "followup_3"
  | "interested"
  | "back_burner"
  | "booked"
  | "closed"
  | "closed_not_me"
  | "not_interested"
  | "cant_pay"
  | "junk";

export const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "blocked",
  "reached_out",
  "followup_1",
  "followup_2",
  "followup_3",
  "interested",
  "back_burner",
  "booked",
  "closed",
  "closed_not_me",
  "not_interested",
  "cant_pay",
  "junk",
];

export const PIPELINE_STATUSES: LeadStatus[] = [
  "new",
  "reached_out",
  "followup_1",
  "followup_2",
  "followup_3",
  "interested",
  "back_burner",
  "booked",
  "closed",
];

/** Where a lead originated: outbound discovery vs. the jeffflake.com form. */
export type LeadSource = "outbound" | "website_inbound" | "bot_import";

/**
 * What a lead is (migration 0036): a speaking prospect, or a non-booking
 * website inquiry (press, interview/student, other) that is handled by hand
 * and kept out of outreach, enrichment, follow-ups and pipeline stats.
 */
export type LeadKind = "speaking" | "inquiry";
export type InquiryType = "press" | "interview_student" | "other";

/**
 * "bounced" = a hard bounce came back; "invalid" = the email verifier says the
 * mailbox doesn't exist. Neither is ever emailed again (migration 0031).
 */
export type ContactStatus =
  | "verified"
  | "unverified"
  | "needs_lookup"
  | "bounced"
  | "invalid";

/**
 * "blocked" = the engagement guard refused to send because the organization
 * is already in a conversation (see lib/outreach/guard.ts). Never retried
 * automatically; only an explicit operator override can send it.
 */
export type OutreachStatus = "draft" | "queued" | "sent" | "failed" | "blocked";

/**
 * How an outreach email left the building: sent by this app, or sent by hand
 * from the Gmail inbox and imported later. Commission follows the FIRST
 * outreach to a lead, and only app-sent outreach is the operator's.
 */
export type OutreachChannel = "app" | "gmail";

/** Operator override of who started the conversation (migration 0034). */
export type AttributionOverride = "app" | "not_app";

export type RuleType =
  | "discovery_filter"
  | "copy_style"
  | "targeting"
  | "other";

export type InteractionKind =
  | "status_change"
  | "note"
  | "email_sent"
  | "followup_sent"
  | "discovered";

export interface Lead {
  id: string;
  name: string;
  type: LeadType;
  description: string | null;
  location_country: string | null;
  location_region: string | null;
  website: string | null;
  source_url: string | null;
  fit_rationale: string | null;
  suggested_topics: string[];
  status: LeadStatus;
  /** When to pick the conversation back up (YYYY-MM-DD); any status. */
  revisit_on: string | null;
  /** Why / what to do on the revisit date (migration 0034). */
  revisit_note?: string | null;
  /** Set when this duplicate was merged into another lead (migration 0034). */
  merged_into_id?: string | null;
  /**
   * Explicit attribution override (migration 0034). When set, it wins over
   * the channel of the first sent outreach everywhere origin is shown.
   */
  attribution_override?: AttributionOverride | null;
  attribution_override_reason?: string | null;
  attribution_override_by?: string | null;
  attribution_override_at?: string | null;
  source: LeadSource;
  /** Absent until migration 0036; treat missing as 'speaking'. */
  kind?: LeadKind;
  inquiry_type?: InquiryType | null;
  name_normalized: string;
  created_at: string;
  updated_at: string;
  /**
   * Contact finding + drafting queue state (migration 0030; absent before it
   * is applied). null = never queued.
   */
  enrich_status?: EnrichStatus | null;
  enrich_started_at?: string | null;
  enrich_error?: string | null;
}

export type EnrichStatus = "pending" | "working" | "done" | "error";

export interface Contact {
  id: string;
  lead_id: string;
  name: string | null;
  role: string | null;
  email: string | null;
  contact_status: ContactStatus;
  source_url: string | null;
  /** When the paid email provider was last asked about this person (null = never). */
  email_lookup_attempted_at: string | null;
  /** Last email-verifier check (migration 0033; absent before it). */
  verification_checked_at?: string | null;
  /** That check's result, e.g. "zerobounce:catch-all" (migration 0033). */
  verification_result?: string | null;
  /**
   * The contact who pointed us to this person ("talk to X instead"), on the
   * same lead (migration 0034). Referred contacts are handled by hand: never
   * cold-emailed or followed up automatically.
   */
  referred_by_contact_id?: string | null;
  /** Optional phone number (migration 0034). */
  phone?: string | null;
  /**
   * Holiday out-of-office (migration 0035): nothing is sent to this contact
   * before this date (YYYY-MM-DD, inclusive resume date).
   */
  ooo_until?: string | null;
  /** Why, e.g. "Holiday OOO: back Jan 2, 2027" (migration 0035). */
  ooo_reason?: string | null;
  created_at: string;
}

export interface Outreach {
  id: string;
  lead_id: string;
  contact_id: string | null;
  subject: string;
  body: string;
  status: OutreachStatus;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  error: string | null;
  sent_at: string | null;
  replied_at: string | null;
  bounced_at: string | null;
  sent_via: OutreachChannel;
  /** When a queued email is due to go out (null unless status is 'queued'). */
  scheduled_for: string | null;
  /** 0 = initial outreach, 1..n = follow-up number in the thread. */
  sequence_step: number;
  /** The initial outreach this follow-up belongs to (null on step 0). */
  parent_outreach_id: string | null;
  /**
   * Set when the operator explicitly chose to send despite the engagement
   * guard reporting an existing conversation. Null for every normal send.
   */
  guard_override_reason: string | null;
  guard_override_at: string | null;
  created_at: string;
}

// ---- Automated follow-ups -------------------------------------------------
export type FollowupSequenceStatus =
  | "active"
  | "paused"
  | "completed"
  | "stopped";

export interface FollowupSequence {
  id: string;
  outreach_id: string;
  lead_id: string;
  contact_id: string | null;
  steps_sent: number;
  max_steps: number;
  next_due_at: string | null;
  status: FollowupSequenceStatus;
  stop_reason: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Engagement outcome (migration 0037). The DB trigger fills it when null. */
export type BookingOutcome = "completed" | "upcoming" | "canceled";
export const BOOKING_OUTCOMES: BookingOutcome[] = ["completed", "upcoming", "canceled"];

/**
 * One engagement (a speaking gig) for a lead. The bookings table is the
 * engagement history: a lead keeps one status, and each year Jeff spoke there
 * is a row here (migration 0037 added event_year, outcome and the rest).
 */
export interface Booking {
  id: string;
  lead_id: string;
  event_name: string;
  event_date: string | null;
  topic: string | null;
  fee: number | null;
  is_recurring: boolean;
  notes: string | null;
  created_at: string;
  /** Filled from event_date (or guessed from the name/notes) by trigger. */
  event_year?: number | null;
  outcome?: BookingOutcome | null;
  event_end_date?: string | null;
  location?: string | null;
  /** 'bot_import' for engagements the bot API created; null = by hand. */
  source?: string | null;
  source_inbox?: string | null;
  updated_at?: string | null;
}

// ---- Bot import API (migration 0037) -------------------------------------
export interface BotApiKey {
  id: string;
  label: string;
  /** sha256 hex of the raw key. Server-only: never sent to the browser. */
  key_hash: string;
  key_prefix: string | null;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface BotActivity {
  id: string;
  key_id: string | null;
  bot_name: string | null;
  method: string | null;
  endpoint: string | null;
  lead_id: string | null;
  source_inbox: string | null;
  summary: string | null;
  status_code: number | null;
  created_at: string;
}

export type MessageDirection = "inbound" | "outbound";

/** One email in a lead's correspondence log, imported from any inbox. */
export interface LeadMessage {
  id: string;
  lead_id: string;
  contact_id: string | null;
  outreach_id: string | null;
  direction: MessageDirection;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  sent_at: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  source_inbox: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  rfc822_message_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface TailoringRule {
  id: string;
  raw_instruction: string;
  rule_type: RuleType;
  structured_value: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

export interface Interaction {
  id: string;
  lead_id: string | null;
  kind: InteractionKind;
  detail: string | null;
  created_at: string;
  /** Who wrote it: 'bot:<name>', 'user', 'system'; null = legacy (0037). */
  actor?: string | null;
  /** Inbox the entry came from, for bot imports (0037). */
  source_inbox?: string | null;
}

export interface GmailConnection {
  id: number;
  email: string | null;
  refresh_token: string | null;
  access_token: string | null;
  expiry: string | null;
  scopes: string | null;
  connected_at: string;
  updated_at: string;
}

// ---- Voice & Insights -----------------------------------------------------
export type InsightCategory = "voice" | "tactics" | "structure" | "cadence";

export interface SuggestedRule {
  id: string;
  rule_type: RuleType;
  raw_instruction: string;
  structured_value: Record<string, unknown>;
  accepted: boolean;
}

export interface VoiceProfile {
  id: string;
  version: number;
  is_active: boolean;
  tone_summary: string | null;
  structure_summary: string | null;
  tactics_summary: string | null;
  cadence_summary: string | null;
  prompt_injection: string | null;
  suggested_rules: SuggestedRule[];
  source_message_count: number;
  created_at: string;
}

export interface EmailInsight {
  id: string;
  voice_profile_id: string;
  category: InsightCategory;
  insight: string;
  example_excerpt: string | null;
  created_at: string;
}

/** In-memory representation of a fetched Gmail message (never persisted raw). */
export interface IngestedMessage {
  id: string;
  threadId: string;
  labels: string[];
  internalDate: string; // ISO
  from: string;
  to: string;
  subject: string;
  body: string;
  isSent: boolean;
}

// ---- Lead + relations (used in detail views) ------------------------------
export interface LeadWithRelations extends Lead {
  contacts: Contact[];
  outreach: Outreach[];
  bookings: Booking[];
}

// ---- Discovery candidate (Claude output, pre-persist) ---------------------
export interface DiscoveredLead {
  name: string;
  type: LeadType;
  description: string;
  location_country: string;
  location_region: string | null;
  website: string | null;
  source_url: string;
  fit_rationale: string;
  suggested_topics: string[];
  contact?: {
    name: string | null;
    role: string | null;
    email: string | null;
    contact_status: ContactStatus;
    source_url: string | null;
  };
}

// ---- Structured tailoring-rule values -------------------------------------
export interface DiscoveryFilterValue {
  exclude_countries?: string[];
  include_countries?: string[];
  exclude_keywords?: string[];
}

export interface TargetingValue {
  prioritize_types?: string[];
  deprioritize_types?: string[];
  focus?: string;
}

export interface CopyStyleValue {
  tone?: string;
  emphasize?: string[];
  deemphasize?: string[];
  forbid?: string[]; // e.g. ["em_dash"]
  max_words?: number;
  instructions?: string[];
}
