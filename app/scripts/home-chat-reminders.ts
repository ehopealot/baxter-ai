// Home Chat has no return channel for scheduled work. Resolve the authenticated
// `member:<address>` identity to that one household contact's explicit SMS/email
// delivery targets, without using a display-name guess or borrowing another
// member's address. The scheduler persists the resulting primary target and an
// optional email fallback separately (see schedule-store.ts).
import { admitEmail, admitPhone, loadAllowlist } from "./allowlist.ts";
import { ALLOWLIST_PATH } from "./paths.ts";
import { resolveRecipients } from "./recipients.ts";

export interface HomeChatReminderRoute {
  sms: string | null;
  email: string | null;
}

const noRoute = (): HomeChatReminderRoute => ({ sms: null, email: null });

export function resolveHomeChatReminderRoute(
  authorId: string,
  env: NodeJS.ProcessEnv = process.env,
  allowlistPath: string = ALLOWLIST_PATH,
): HomeChatReminderRoute {
  if (!authorId.startsWith("member:")) return noRoute();
  const rawAddress = authorId.slice("member:".length);
  const authorPhone = admitPhone(rawAddress);
  const address = admitEmail(rawAddress) ?? authorPhone;
  if (address === null) return noRoute();

  const { contacts } = resolveRecipients(loadAllowlist(env, allowlistPath), env);
  const matches = contacts.filter(contact =>
    contact.phones.includes(address)
    || contact.emails.includes(address)
    || contact.identityEmails?.includes(address),
  );
  // A contact may have several aliases, but the identity itself must resolve to
  // exactly one contact. Ambiguity means no scheduled delivery target rather than
  // a potentially private message to the wrong household member.
  if (matches.length !== 1) return noRoute();
  const contact = matches[0]!;
  // A phone-authenticated author chose that exact direct alias; preserve it
  // rather than silently selecting another phone on the same resolved contact.
  return { sms: authorPhone ?? contact.phones[0] ?? null, email: contact.emails[0] ?? null };
}
