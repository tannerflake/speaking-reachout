"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { disconnectGmail } from "@/app/actions/gmail";

export function GmailConnection({
  connected,
  email,
}: {
  connected: boolean;
  email: string | null;
}) {
  const params = useSearchParams();
  const status = params.get("gmail");
  const [pending, start] = useTransition();
  const router = useRouter();

  function disconnect() {
    start(async () => {
      await disconnectGmail();
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-medium text-zinc-700">Gmail connection</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Outreach is sent from this connected Google account.
      </p>

      {status === "connected" && (
        <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Gmail connected successfully.
        </p>
      )}
      {status === "no_refresh" && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Connected, but Google didn&apos;t return a refresh token. Disconnect and
          reconnect, choosing the account and granting access again.
        </p>
      )}
      {status === "error" && (
        <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          Gmail connection failed. Check your Google OAuth env vars and redirect
          URI, then try again.
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        {connected ? (
          <>
            <span className="text-sm text-zinc-700">
              Connected{email ? ` as ${email}` : ""}.
            </span>
            <button
              onClick={disconnect}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
            >
              {pending ? "Disconnecting…" : "Disconnect"}
            </button>
            <a
              href="/api/gmail/connect"
              className="text-sm text-blue-600 hover:underline"
            >
              Reconnect
            </a>
          </>
        ) : (
          <a
            href="/api/gmail/connect"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Connect Gmail
          </a>
        )}
      </div>
    </div>
  );
}
