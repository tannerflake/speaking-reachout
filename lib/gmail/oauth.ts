import { google } from "googleapis";
import type { NextRequest } from "next/server";
import { requireEnv } from "@/lib/env";

// gmail.send to send outreach; gmail.readonly to ingest the archive for the
// Voice & Insights feature (read-only analysis of Jeff's mail);
// userinfo.email/openid so we can show which account is connected.
export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  GMAIL_READONLY_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

/**
 * Build the OAuth client.
 *
 * Pass the per-request callback URL (from {@link gmailCallbackUrl}) for the
 * consent + token-exchange steps. Omit it for refresh-token operations
 * (send/ingest), where the redirect URI is never used.
 */
export function createOAuthClient(redirectUri?: string) {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri,
  );
}

export function getAuthUrl(redirectUri: string, state?: string): string {
  const client = createOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: "offline", // request a refresh token
    prompt: "consent", // force refresh-token issuance on reconnect
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/**
 * The Gmail OAuth callback URL for the CURRENT request's origin, derived from
 * forwarded headers so it works on the live domain and localhost alike — never
 * a hardcoded value. The exact same URL must be used to start consent and to
 * exchange the code (Google requires them to match), and it must be registered
 * in the Google Cloud console under "Authorized redirect URIs".
 */
export function gmailCallbackUrl(request: NextRequest): string {
  return `${publicOrigin(request)}/api/gmail/callback`;
}

/** Public origin of the request, honoring reverse-proxy forwarded headers. */
export function publicOrigin(request: NextRequest): string {
  const fwdProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const fwdHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = fwdProto || request.nextUrl.protocol.replace(/:$/, "");
  const host = fwdHost || request.headers.get("host") || request.nextUrl.host;
  return `${proto}://${host}`;
}
