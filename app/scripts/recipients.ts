// Shared household contact resolution for daily calendar digest and weekly household
// delivery: turn a FRESH allowlist snapshot + env into one ResolvedContact per household
// member so runtime delivery can send individually -- SMS first, then only the SAME
// contact's email as fallback -- without ever mixing one person's phone with another
// person's email. Pure: the caller resolves one pre-generation allowlist snapshot, and
// every send later re-enters sendSms/sendNew's fresh provider admission guards; this
// module only decides WHO the contacts are. There is exactly ONE identity rule here --
// cleanForPromptLine, the same cleaning household.ts's roster groups by (an
// attacker-controlled name is flattened to a single safe line before any equality test)
// -- plus dedup, collision, and operator
// merge guards; nothing infers identity beyond it.
//
// Resolution order (plan T10 rules 0-7):
//   0. canonical-address dedup of the admitted candidate pool BEFORE grouping (a raw
//      duplicate or case-variant spelling of one address collapses to one candidate, so
//      it can never masquerade as a duplicate-nickname collision);
//   1. group recipient emails by exact cleaned display name;
//   2. a name held by exactly ONE recipient email pairs with all same-name phones;
//   3. a name held by TWO OR MORE distinct recipient emails is ambiguous -- each email
//      is its own email-only contact and the same-name phones land in unresolvedPhones;
//   4. the explicit OPERATOR_PHONE/OPERATOR_EMAIL pair merges into already-resolved
//      contacts instead of minting duplicates (never merging across two different
//      contacts -- that would be a second identity rule);
//   5./6. leftover unnamed/leftover candidates become single-channel legacy contacts;
//   7. a final cross-contact dedup backstop plus deterministic ordering.
import type { Allowlist } from "./allowlist.ts";
import { admittedRosterPhone, admitEmail, admitPhone } from "./allowlist.ts";
import { cleanForPromptLine } from "./transcript.ts";

export interface ResolvedContact {
  name?: string;
  phones: string[];
  emails: string[];
}

export interface ResolvedRecipients {
  contacts: ResolvedContact[];
  unresolvedPhones: string[];
  unpairedOperatorPair: boolean;
}

// Admission runs through allowlist.ts's shared admitEmail/admitPhone predicates (the
// same ONE copy the roster render and the SMS-side roster check use -- see allowlist.ts
// for the rationale): loadAllowlist only filters entries to strings, and the allowlist
// file is hand-editable, so shape is re-checked here. Canonical form = the admission
// key: lowercased email / E.164 phone as-is (the same form allowlist.ts's names map
// is keyed on).

// The operator pair's phone-admission check: a strict E.164 entry in senders ∪
// recipients equals the requested number EXACTLY -- the same shared predicate
// sms-cli.ts's admittedRecipient applies for 1:1 sends (an unlisted number is never
// texted, so the operator pair can never smuggle an off-roster phone into delivery).
function operatorPhoneOnRoster(norm: string, list: Allowlist): boolean {
  return admittedRosterPhone(list, norm);
}

function makeContact(name: string | undefined, phones: string[], emails: string[]): ResolvedContact {
  const contact: ResolvedContact = { phones, emails };
  if (name !== undefined && name !== "") contact.name = name;
  return contact;
}

function uniqueAdmitted(candidates: readonly string[], admit: (raw: string) => string | null): string[] {
  const admitted: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const canon = admit(raw);
    if (canon !== null && !seen.has(canon)) {
      seen.add(canon);
      admitted.push(canon);
    }
  }
  return admitted;
}

export function resolveRecipients(list: Allowlist, env: NodeJS.ProcessEnv): ResolvedRecipients {
  // Rule 0 -- candidate pools, canonicalized and deduped BEFORE any name grouping.
  // Emails are recipients-only (the digest goes to members who can receive); phones are
  // admitted from senders ∪ recipients (the same union sendSms's admission checks), so a
  // phone listed in both collapses to one candidate.
  const emails = uniqueAdmitted(list.recipients, admitEmail);
  const phones = uniqueAdmitted([...list.senders, ...list.recipients], admitPhone);

  const cleanedName = (canon: string): string => cleanForPromptLine(list.names?.[canon] ?? "");

  // Rule 1 -- group recipient emails by exact cleaned display name.
  const byName = new Map<string, string[]>();
  const unnamedEmails: string[] = [];
  for (const email of emails) {
    const name = cleanedName(email);
    if (name === "") unnamedEmails.push(email);
    else {
      const bucket = byName.get(name);
      if (bucket === undefined) byName.set(name, [email]);
      else bucket.push(email);
    }
  }

  const contacts: ResolvedContact[] = [];
  const emailToContact = new Map<string, ResolvedContact>();
  const phoneToContact = new Map<string, ResolvedContact>();
  const unresolved = new Set<string>();

  for (const [name, group] of byName) {
    if (group.length === 1) {
      // Rule 2 -- an unambiguous name pairs its recipient email with every same-name
      // admitted phone: SMS-first with the contact's email as fallback.
      const paired = phones.filter((p) => cleanedName(p) === name);
      const contact = makeContact(name, paired, [group[0]]);
      contacts.push(contact);
      emailToContact.set(group[0], contact);
      for (const p of paired) phoneToContact.set(p, contact);
    } else {
      // Rule 3 -- duplicate-nickname collision: every email delivers independently as
      // an email-only contact (no same-name phone pairs with any of them) and the
      // affected phone candidates are reported back for deterministic logging.
      for (const email of group) {
        const contact = makeContact(name, [], [email]);
        contacts.push(contact);
        emailToContact.set(email, contact);
      }
      for (const p of phones) if (cleanedName(p) === name) unresolved.add(p);
    }
  }

  // Rule 4 -- the explicit operator pair, trusted only while BOTH addresses are
  // currently admitted (the phone passes the roster admission check; the email is the
  // non-empty env OPERATOR_EMAIL itself, mirroring mail's union of the operator), and
  // never minting a second contact for an address rules 0-3 already resolved.
  const opEmail = admitEmail(env.OPERATOR_EMAIL ?? "");
  const opPhone = admitPhone(env.OPERATOR_PHONE ?? "");
  let unpairedOperatorPair = false;
  if (opEmail !== null && opPhone !== null && operatorPhoneOnRoster(opPhone, list)) {
    const emailContact = emailToContact.get(opEmail);
    const phoneContact = phoneToContact.get(opPhone);
    if (emailContact !== undefined && phoneContact !== undefined) {
      // Both already resolved: same contact -> no-op; different contacts -> merge in
      // NEITHER direction (either merge would attach one person's phone to another
      // person's email -- a second identity rule). Flag for the caller to log.
      if (emailContact !== phoneContact) unpairedOperatorPair = true;
    } else if (emailContact !== undefined) {
      // Only the email resolved: its contact absorbs the phone (SMS-first still
      // applies) and the phone leaves unresolvedPhones -- the explicit pair is trusted
      // config, so a phone stranded by a rule-3 collision is rescued to the operator's
      // own contact, never the other collision member's.
      emailContact.phones.push(opPhone);
      phoneToContact.set(opPhone, emailContact);
      unresolved.delete(opPhone);
    } else if (phoneContact !== undefined) {
      // Only the phone resolved: the operator email joins THAT contact's candidates.
      phoneContact.emails.push(opEmail);
      emailToContact.set(opEmail, phoneContact);
    } else {
      // Neither resolved: the explicit pair forms a new operator contact, carrying the
      // names-map name of either address when one exists. A phone stranded by a rule-3
      // collision is rescued exactly like the email-absorption branch above: the minted
      // contact carries it, so it leaves unresolvedPhones (never a false warning).
      const name = cleanedName(opEmail) !== "" ? cleanedName(opEmail) : cleanedName(opPhone);
      const contact = makeContact(name === "" ? undefined : name, [opPhone], [opEmail]);
      contacts.push(contact);
      emailToContact.set(opEmail, contact);
      phoneToContact.set(opPhone, contact);
      unresolved.delete(opPhone);
    }
  }

  // Rules 5/6 -- legacy contacts for candidates nothing above resolved. An unnamed
  // email is email-only; a phone that neither paired (rule 2), collided (rule 3), nor
  // was absorbed by the operator pair is phone-only -- with no inferred fallback: no
  // email is ever guessed for a phone-only member. (A phone whose cleaned name has no
  // same-name recipient email still resolves, carrying its name -- dropping an admitted
  // household phone would silently skip a member; it simply has no email fallback.)
  for (const email of unnamedEmails) {
    if (emailToContact.has(email)) continue; // operator pairing already resolved it
    const contact = makeContact(undefined, [], [email]);
    contacts.push(contact);
    emailToContact.set(email, contact);
  }
  for (const phone of phones) {
    if (phoneToContact.has(phone) || unresolved.has(phone)) continue;
    const name = cleanedName(phone);
    const contact = makeContact(name === "" ? undefined : name, [phone], []);
    contacts.push(contact);
    phoneToContact.set(phone, contact);
  }

  // Rule 7 -- the belt-and-suspenders backstop: one contact per canonical address, so
  // delivery can make at most one successful delivery per resolved contact even if a
  // future seam reintroduces a shared address; then deterministic ordering (contacts by
  // name-then-address, candidates lexicographically) via plain code-unit comparison.
  const deduped: ResolvedContact[] = [];
  const owner = new Map<string, number>();
  for (const contact of contacts) {
    const addresses = [...contact.emails, ...contact.phones];
    let target = -1;
    for (const address of addresses) {
      const found = owner.get(address);
      if (found !== undefined) { target = found; break; }
    }
    if (target === -1) {
      deduped.push(contact);
      const idx = deduped.length - 1;
      for (const address of addresses) owner.set(address, idx);
    } else {
      const kept = deduped[target];
      for (const email of contact.emails) if (!kept.emails.includes(email)) kept.emails.push(email);
      for (const phone of contact.phones) if (!kept.phones.includes(phone)) kept.phones.push(phone);
      if (kept.name === undefined && contact.name !== undefined) kept.name = contact.name;
      for (const address of addresses) owner.set(address, target);
    }
  }
  const lex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const contact of deduped) { contact.phones.sort(lex); contact.emails.sort(lex); }
  deduped.sort((a, b) => {
    const byName = lex(a.name ?? "", b.name ?? "");
    if (byName !== 0) return byName;
    return lex(a.emails[0] ?? a.phones[0] ?? "", b.emails[0] ?? b.phones[0] ?? "");
  });

  return {
    contacts: deduped,
    unresolvedPhones: [...unresolved].sort(lex),
    unpairedOperatorPair,
  };
}
