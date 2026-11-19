/**
 * Email domains shared by many unrelated events or organizations: the big
 * trade-show and conference companies (one Informa address runs hundreds of
 * different events) and the event platforms that send on organizers' behalf.
 *
 * A shared domain says nothing about WHICH event someone works on, so the
 * engagement guard never treats it as an organization's identity: two leads
 * on @informa.com are not the same org, and mail with someone @informa.com is
 * only a conflict when it is with the same person or names the same event.
 */
export const SHARED_EVENT_DOMAINS = new Set([
  // Informa (and brands it absorbed)
  "informa.com",
  "informamarkets.com",
  "informaconnect.com",
  "knect365.com",
  "ubm.com",
  "penton.com",
  // Other large exhibition / conference organizers
  "hyve.group",
  "hyvegroup.com",
  "emeraldx.com",
  "emeraldexpositions.com",
  "clarionevents.com",
  "rxglobal.com",
  "reedexpo.com",
  "reedexhibitions.com",
  "comexposium.com",
  "messefrankfurt.com",
  "tarsus.com",
  "tarsusgroup.com",
  "ascential.com",
  "questex.com",
  "endeavorb2b.com",
  "endeavorbusinessmedia.com",
  "diversifiedcommunications.com",
  "divcom.com",
  "terrapinn.com",
  "easyfairs.com",
  "smartershows.com",
  "ite-events.com",
  "freeman.com",
  "mci-group.com",
  // Event platforms that mail on behalf of many organizers
  "cvent.com",
  "eventbrite.com",
  "bizzabo.com",
  "swapcard.com",
  "whova.com",
  "hopin.com",
  "eventsair.com",
]);

export function isSharedEventDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && SHARED_EVENT_DOMAINS.has(domain.toLowerCase()));
}
