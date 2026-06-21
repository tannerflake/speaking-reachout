import { getActiveVoiceProfile, getVoiceInsights } from "@/lib/data";
import { getGmailStatus } from "@/lib/gmail/connection";
import { VoiceInsightsView } from "@/components/VoiceInsightsView";

export const dynamic = "force-dynamic";
// Ingestion + multi-pass analysis is long-running — give it headroom
// (effective on Vercel Pro/Enterprise; Hobby caps lower — see README).
export const maxDuration = 300;

export default async function VoiceInsightsPage() {
  const [profile, gmail] = await Promise.all([
    getActiveVoiceProfile(),
    getGmailStatus(),
  ]);
  const insights = profile ? await getVoiceInsights(profile.id) : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Voice &amp; Insights</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Analyze Jeff&apos;s email history to learn his voice and proven
          tactics, then feed that into the draft engine so generated outreach
          sounds like him.
        </p>
      </div>
      <VoiceInsightsView profile={profile} insights={insights} gmail={gmail} />
    </div>
  );
}
