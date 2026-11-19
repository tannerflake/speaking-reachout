import type { HunterStatus } from "@/lib/contacts/hunterStatus";

/**
 * Hunter credit / failure banner (Dashboard and Discover). Renders nothing
 * while Hunter is healthy.
 */
export function HunterWarning({ status }: { status: HunterStatus }) {
  if (!status.warning) return null;
  const error = status.level === "error";
  return (
    <div
      role="alert"
      className={`rounded-lg border px-4 py-3 text-sm ${
        error
          ? "border-rose-300 bg-rose-50 text-rose-800"
          : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
    >
      <span className="font-medium">
        {error ? "Hunter is not finding emails. " : "Hunter credits are low. "}
      </span>
      {status.warning}
    </div>
  );
}
