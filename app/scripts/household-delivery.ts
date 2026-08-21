import type { ResolvedContact } from "./recipients.ts";

export interface HouseholdDeliveryCounts {
  contacts: number;
  sms: number;
  email: number;
  failed: number;
}

const MAX_DIAGNOSTIC_CHARS = 1200;

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

// Provider messages are untrusted and can echo outbound or recipient data. Only
// a fixed category and an already-structured provider code can cross this seam.
function safeProviderError(error: unknown): string {
  const message = typeof (error as { message?: unknown })?.message === "string"
    ? (error as { message: string }).message.toLowerCase()
    : "";
  let category = "provider";
  if (/allowlist|admission|recipient|moderation|refus/.test(message)) category = "admission";
  else if (/daily cap|rate.?limit|quota|limit exceeded/.test(message)) category = "cap";
  else if (/timeout|timed out/.test(message)) category = "timeout";
  const rawCode = (error as { code?: unknown })?.code;
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : null;
  return `category=${category}${code ? ` code=${code}` : ""}`;
}

function boundedLog(log: (message: string) => void, message: string): void {
  log(oneLine(message).slice(0, MAX_DIAGNOSTIC_CHARS));
}

export interface HouseholdDeliveryOptions {
  contacts: readonly ResolvedContact[];
  subjectFor(contact: ResolvedContact, index: number): string;
  bodyFor(contact: ResolvedContact, index: number): string;
  sendSms(phone: string, body: string): Promise<unknown>;
  sendEmail(email: string, subject: string, body: string): Promise<unknown>;
  log(message: string): void;
  taskLabel: string;
  contactIndexOffset?: number;
}

// One bounded sequential SMS-first, same-contact-email-fallback chain per index.
// Subject/body are computed once per contact and reused byte-for-byte across that
// contact's provider attempts. Diagnostics structurally omit identities/content.
export async function deliverToHousehold(options: HouseholdDeliveryOptions): Promise<HouseholdDeliveryCounts> {
  let sms = 0;
  let email = 0;
  let failed = 0;

  for (let localIndex = 0; localIndex < options.contacts.length; localIndex++) {
    const contact = options.contacts[localIndex]!;
    const index = (options.contactIndexOffset ?? 0) + localIndex;
    const subject = options.subjectFor(contact, index);
    const body = options.bodyFor(contact, index);
    const failures: string[] = [];
    let delivered = false;
    let successfulChannel: "sms" | "email" | null = null;

    for (const phone of contact.phones) {
      try {
        await options.sendSms(phone, body);
        sms++;
        delivered = true;
        successfulChannel = "sms";
        break;
      } catch (error) {
        failures.push(`channel=sms ${safeProviderError(error)}`);
      }
    }

    if (!delivered) {
      for (const address of contact.emails) {
        try {
          await options.sendEmail(address, subject, body);
          email++;
          delivered = true;
          successfulChannel = "email";
          break;
        } catch (error) {
          failures.push(`channel=email ${safeProviderError(error)}`);
        }
      }
    }

    if (!delivered) {
      failed++;
      boundedLog(options.log, `${options.taskLabel}: contact=${index} delivery failed${failures.length ? ` (${failures.join("; ")})` : ""}`);
    } else if (failures.length > 0) {
      boundedLog(options.log, `${options.taskLabel}: contact=${index} delivered channel=${successfulChannel}${failures.length ? ` (${failures.join("; ")})` : ""}`);
    }
  }

  return { contacts: options.contacts.length, sms, email, failed };
}
