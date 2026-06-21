import { Suspense } from "react";
import { getAllRules } from "@/lib/data";
import { getGmailStatus } from "@/lib/gmail/connection";
import { RulesManager } from "@/components/RulesManager";
import { GmailConnection } from "@/components/GmailConnection";

export const dynamic = "force-dynamic";

export default async function TailoringPage() {
  const [rules, gmail] = await Promise.all([getAllRules(), getGmailStatus()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Tailoring</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Tune outreach behavior in plain English and manage the Gmail
          connection. Rules persist and apply to every future Discover and Draft
          operation until you disable or delete them.
        </p>
      </div>

      <Suspense>
        <GmailConnection connected={gmail.connected} email={gmail.email} />
      </Suspense>

      <div>
        <h2 className="mb-2 text-sm font-medium text-zinc-500">
          Tailoring rules
        </h2>
        <RulesManager rules={rules} />
      </div>
    </div>
  );
}
