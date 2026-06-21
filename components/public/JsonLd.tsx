const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://jeffflake.com";

/**
 * Person + Service structured data to help "Jeff Flake speaker" search
 * results. Rendered as a JSON-LD script in the document.
 */
export function JsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Person",
        name: "Jeff Flake",
        honorificPrefix: "Ambassador",
        jobTitle: "Speaker, former U.S. Senator and Ambassador",
        description:
          "Senator. Ambassador. Author. A voice that challenges without polarizing.",
        url: SITE_URL,
        sameAs: [],
      },
      {
        "@type": "Service",
        serviceType: "Keynote and event speaking",
        provider: { "@type": "Person", name: "Jeff Flake" },
        areaServed: "US",
        description:
          "Book Ambassador Jeff Flake for keynotes, university events, panels, and leadership summits.",
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      // Structured data is static and trusted; safe to inline.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
