import { createAdminClient } from "@/lib/supabase/admin";
import type { GmailConnection } from "@/lib/types";

// All gmail_connection access goes through the service-role client — the table
// has no authenticated-role RLS policy, so the refresh token never reaches the
// browser or a user-scoped query.

export async function getGmailConnection(): Promise<GmailConnection | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("gmail_connection")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  return (data as GmailConnection) ?? null;
}

/** Public-safe view of the connection for client components. */
export async function getGmailStatus(): Promise<{
  connected: boolean;
  email: string | null;
}> {
  const conn = await getGmailConnection();
  return {
    connected: Boolean(conn?.refresh_token),
    email: conn?.email ?? null,
  };
}

export async function saveGmailTokens(input: {
  email: string | null;
  refresh_token?: string | null;
  access_token?: string | null;
  expiry?: string | null;
}): Promise<void> {
  const admin = createAdminClient();

  // Preserve an existing refresh token if Google didn't return a new one.
  const existing = await getGmailConnection();
  const refresh_token = input.refresh_token ?? existing?.refresh_token ?? null;

  const { error } = await admin.from("gmail_connection").upsert(
    {
      id: 1,
      email: input.email ?? existing?.email ?? null,
      refresh_token,
      access_token: input.access_token ?? null,
      expiry: input.expiry ?? null,
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`Failed to save Gmail tokens: ${error.message}`);
}

export async function clearGmailConnection(): Promise<void> {
  const admin = createAdminClient();
  await admin.from("gmail_connection").delete().eq("id", 1);
}
