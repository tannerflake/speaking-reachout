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
  "booked",
  "closed",
];

/** Where a lead originated: outbound discovery vs. the jeffflake.com form. */
export type LeadSource = "outbound" | "website_inbound";

export type ContactStatus = "verified" | "unverified" | "needs_lookup";

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
  source: LeadSource;
  name_normalized: string;
  created_at: string;
  updated_at: string;
}

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
