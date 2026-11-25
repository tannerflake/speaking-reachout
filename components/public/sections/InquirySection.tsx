import { PublicInquiryForm } from "@/components/public/PublicInquiryForm";

/**
 * Quiet, secondary call to action below the booking section: media requests,
 * interviews, students, anything that isn't a speaking booking.
 */
export function InquirySection({ fallbackEmail }: { fallbackEmail: string }) {
  return (
    <section
      id="inquiries"
      className="scroll-mt-20 border-t border-rule bg-paper py-14 sm:py-16"
    >
      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <h2 className="font-display text-2xl font-medium text-oxford sm:text-3xl">
          Press &amp; other inquiries
        </h2>
        <p className="mt-2 text-base leading-relaxed text-graphite/75">
          Media requests, interviews, and anything that isn&rsquo;t a speaking
          booking.
        </p>
        <div className="mt-6">
          <PublicInquiryForm fallbackEmail={fallbackEmail} />
        </div>
      </div>
    </section>
  );
}
