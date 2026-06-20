import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/gmail/oauth";

// Kicks off the Gmail OAuth consent flow. Gated by middleware (operator must
// be logged in).
export async function GET() {
  try {
    return NextResponse.redirect(getAuthUrl());
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
