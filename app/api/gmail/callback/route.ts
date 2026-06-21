import { NextResponse, type NextRequest } from "next/server";
import { google } from "googleapis";
import { createOAuthClient, gmailCallbackUrl, publicOrigin } from "@/lib/gmail/oauth";
import { saveGmailTokens } from "@/lib/gmail/connection";

export async function GET(request: NextRequest) {
  // Use the request's real origin (not a hardcoded env value) so the flow
  // returns to the same domain it started on — and so the redirect URI here
  // matches the one used to start consent, as Google requires.
  const redirectUri = gmailCallbackUrl(request);
  const settingsUrl = new URL("/admin/settings/tailoring", publicOrigin(request));
  const code = request.nextUrl.searchParams.get("code");
  const oauthError = request.nextUrl.searchParams.get("error");

  if (oauthError || !code) {
    settingsUrl.searchParams.set("gmail", "error");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const oauth = createOAuthClient(redirectUri);
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);

    // Best-effort: capture which account was connected for display.
    let email: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: "v2", auth: oauth });
      const info = await oauth2.userinfo.get();
      email = info.data.email ?? null;
    } catch {
      // userinfo scope may be unavailable; connection still works for sending.
    }

    await saveGmailTokens({
      email,
      refresh_token: tokens.refresh_token ?? null,
      access_token: tokens.access_token ?? null,
      expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
      scopes: tokens.scope ?? null,
    });

    settingsUrl.searchParams.set(
      "gmail",
      tokens.refresh_token ? "connected" : "no_refresh",
    );
    return NextResponse.redirect(settingsUrl);
  } catch {
    settingsUrl.searchParams.set("gmail", "error");
    return NextResponse.redirect(settingsUrl);
  }
}
