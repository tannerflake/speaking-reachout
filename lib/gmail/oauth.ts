import { google } from "googleapis";
import { requireEnv } from "@/lib/env";

// gmail.send to send mail; userinfo.email/openid so we can show which account
// is connected. gmail.readonly (for reply detection) is intentionally NOT
// requested — it's out of scope for v1 (see README).
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export function createOAuthClient() {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    requireEnv("GOOGLE_REDIRECT_URI"),
  );
}

export function getAuthUrl(state?: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // request a refresh token
    prompt: "consent", // force refresh-token issuance on reconnect
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}
