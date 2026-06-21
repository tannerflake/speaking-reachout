import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "@/lib/env";

/**
 * Anonymous Supabase client with NO cookie/session binding. Safe for the
 * public marketing site: it only ever reads RLS-public data (published
 * site_content / site_images) or performs the anon INSERT into inbound_leads.
 *
 * Because it never touches cookies, pages that use it can be statically
 * rendered / ISR-cached. The anon key is public by design.
 */
export function createPublicClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
