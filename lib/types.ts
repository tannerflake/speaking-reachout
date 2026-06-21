// Domain + database row types. Kept hand-written (small schema) rather than
// generated, so the app has a single source of truth for shapes.

export type LeadType = "event" | "institution" | "other";

export type LeadStatus =
  | "new"
  | "reached_out"
  | "interested"
  | "booked"
  | "closed"
  | "not_interested";

export const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "reached_out",
  "interested",
  "booked",
  "closed",
  "not_interested",
];

export const PIPELINE_STATUSES: LeadStatus[] = [
  "new",
  "reached_out",
  "interested",
  "booked",
  "closed",
];

export type ContactStatus = "verified" | "unverified" | "needs_lookup";

export type OutreachStatus = "draft" | "sent" | "failed";

export type RuleType =
  | "discovery_filter"
  | "copy_style"
  | "targeting"
  | "other";

export type InteractionKind =
  | "status_change"
  | "note"
  | "email_sent"
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
  created_at: string;
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
