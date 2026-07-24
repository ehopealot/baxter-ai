#!/usr/bin/env node
// One-time (idempotent) AgentMail inbox provisioning for `make inbox`. Given
// AGENTMAIL_API_KEY, creates-or-returns Baxter's inbox (keyed on a stable
// clientId, so re-running is safe) on AgentMail's default @agentmail.to domain,
// and prints the two values to set in app/.env: AGENTMAIL_INBOX_ID and
// BAXTER_EMAIL. This replaces the old `make auth` Gmail OAuth bootstrap -- there
// is no token to renew, so it's run once at setup, not weekly.
//
// Field names below (inboxId / address) are read defensively; the full inbox
// object is printed so the exact fields are visible against the installed SDK.
import { AgentMailClient } from "agentmail";

const apiKey = process.env.AGENTMAIL_API_KEY;
if (!apiKey) {
  console.error("AGENTMAIL_API_KEY is not set. Put it in app/.env, then re-run `make inbox`.");
  process.exit(1);
}

const clientId = process.env.AGENTMAIL_INBOX_CLIENT_ID || "baxter";
// The From display name AgentMail stamps on every send/reply (else it defaults to
// "AgentMail"). Kept SEPARATE from PERSONA_NAME (the persona name, "Baxter")
// so email can use a shorter From; override with MAIL_FROM_NAME.
const fromName = process.env.MAIL_FROM_NAME || "Baxter B.";
const client = new AgentMailClient({ apiKey });

const inbox = await client.inboxes.create({ clientId, displayName: fromName });
const inboxId = inbox.inboxId ?? inbox.inbox_id;
const address = inbox.address ?? inbox.email ?? inboxId;

// create() only applies displayName to a NEW inbox; update() converges an EXISTING one
// too, so re-running `make inbox` always fixes a stale From name (review 90cdc12).
// Non-fatal: a failed rename must not mask a successful provision or the printout below.
try {
  await client.inboxes.update(inboxId, { displayName: fromName });
} catch (err) {
  console.warn(`warning: displayName not updated (the inbox itself is fine): ${err?.message ?? err}`);
}

console.log("AgentMail inbox ready.\n");
console.log("Add these to app/.env:");
console.log(`  AGENTMAIL_INBOX_ID=${inboxId}`);
console.log(`  BAXTER_EMAIL=${address}`);
console.log("\nFull inbox object (for reference):");
console.log(JSON.stringify(inbox, null, 2));
