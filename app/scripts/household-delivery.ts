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

// Provider messages are untrusted and can echo all or part of the outbound body.
// Preserve operationally useful categories and structured codes without ever
// copying free-form provider text into logs.
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
  subject: string;
  bodyFor(contact: ResolvedContact): string;
  sendSms(phone: string, body: string): Promise<unknown>;
  sendEmail(email: string, subject: string, body: string): Promise<unknown>;
  log(message: string): void;
  taskLabel: string;
}

// One bounded, sequential attempt chain per resolved household contact. The body is
// computed once and reused for every candidate, so an email fallback can never drift
// from the text attempted by SMS. Only body-free provider diagnostics are logged.
export async function deliverToHousehold(options: HouseholdDeliveryOptions): Promise<HouseholdDeliveryCounts> {
  let sms = 0;
  let email = 0;
  let failed = 0;

  for (const contact of options.contacts) {
    const body = options.bodyFor(contact);
    const label = oneLine(contact.name ?? contact.emails[0] ?? contact.phones[0] ?? "unnamed contact").slice(0, 160);
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
        failures.push(`sms ${phone}: ${safeProviderError(error)}`);
      }
    }

    if (!delivered) {
      for (const address of contact.emails) {
        try {
          await options.sendEmail(address, options.subject, body);
          email++;
          delivered = true;
          successfulChannel = "email";
          break;
        } catch (error) {
          failures.push(`email ${address}: ${safeProviderError(error)}`);
        }
      }
    }

    if (!delivered) {
      failed++;
      boundedLog(options.log, `${options.taskLabel}: delivery failed for ${label} (${failures.join("; ")})`);
    } else if (failures.length > 0) {
      boundedLog(options.log, `${options.taskLabel}: ${label} delivered via ${successfulChannel === "sms" ? "SMS" : "email"} fallback (${failures.join("; ")})`);
    }
  }

  return { contacts: options.contacts.length, sms, email, failed };
}
