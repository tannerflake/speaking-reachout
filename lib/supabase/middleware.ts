import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";

// The public marketing site is open to everyone. Only the admin area and the
// CRM's server-side API routes require a session.
const PROTECTED_PREFIXES = ["/admin", "/api/gmail", "/api/discover"];
// The login screen lives under /admin but must stay reachable while signed out.
const ADMIN_PUBLIC_PATHS = ["/admin/login"];

function isProtected(path: string): boolean {
  if (ADMIN_PUBLIC_PATHS.includes(path)) return false;
  return PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

/**
 * Refreshes the Supabase auth session on every request. The public site is
 * unauthenticated; requests to a protected path (the admin area / CRM APIs)
 * without a session are redirected to /admin/login.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  // If Supabase isn't configured yet, don't hard-fail every request — let the
  // page render so the operator sees a useful error rather than a 500 loop.
  if (!url || !anonKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && isProtected(path)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/admin/login";
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && path === "/admin/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/admin";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
