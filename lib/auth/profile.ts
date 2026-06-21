import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type UserRole = "editor" | "crm_admin";

export interface CurrentUser {
  id: string;
  email: string | null;
  role: UserRole;
}

/**
 * Resolve the signed-in user and their role. Absence of a profiles row
 * defaults to "crm_admin" so the existing CRM operator keeps full access
 * without any setup. To make Jeff an editor, insert/update his profiles row
 * with role = 'editor' (see supabase/migrations/0003_public_site.sql).
 *
 * Returns null when there is no authenticated session.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // profiles is readable by authenticated users, but reading via the service
  // role keeps this resilient even if a row is missing or RLS is tightened.
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role: UserRole =
    (data as { role?: UserRole } | null)?.role === "editor"
      ? "editor"
      : "crm_admin";

  return { id: user.id, email: user.email ?? null, role };
}
