import { NextResponse, type NextRequest } from "next/server";
import { getAuthUrl, gmailCallbackUrl } from "@/lib/gmail/oauth";

// Kicks off the Gmail OAuth consent flow. Gated by middleware (operator must
// be logged in). The callback URL is derived from this request's origin, so it
// returns to whatever domain the operator is actually on.
export async function GET(request: NextRequest) {
  try {
    const redirectUri = gmailCallbackUrl(request);
    return NextResponse.redirect(getAuthUrl(redirectUri));
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "Gmail OAuth is not configured (check GOOGLE_* env vars).",
      },
      { status: 500 },
    );
  }
}
