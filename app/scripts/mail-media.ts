// Pure helpers for routing an inbound email's attachments to the multimodal model.
// mail-bot/mail-cli do the I/O around these -- fetching attachment metadata through Resend,
// then setting BAXTER_MEDIA / BAXTER_MODEL_OVERRIDE on the run --
// while the selection, the prompt marker, and the BAXTER_MEDIA item shape live here so they
// can be unit-tested away from the daemon loop. Mirrors discord-bot.ts's selectMediaAttachments
// (the Discord analog), differing only where email must (no CDN url -> fetch+base64 in the runner).
export interface MailAttachment {
  attachmentId: string;
  contentType?: string;
  filename?: string;
  size?: number;
}
import { isMailForwardableType } from "./harnesses/runner-common.ts";
import type { MediaItem } from "./harnesses/runner-common.ts";

// The trigger's attachments worth forwarding to the multimodal model: exactly the types the
// runner's email branch will attach (image/audio/pdf -- NOT video, out for email v1), via the
// SAME predicate buildEmailPart uses, so a selected item can't be silently dropped downstream.
// Capped at `max` (oldest-first, as listed).
export function selectMailMedia(attachments: MailAttachment[], max: number): MailAttachment[] {
  return attachments.filter((a) => isMailForwardableType(a.contentType)).slice(0, Math.max(0, max));
}

// A short human marker of ALL the trigger's attachments (not just the forwardable ones),
// for the prompt -- so a run knows media arrived even when routing is off, or a type doesn't
// forward (a .zip, or video over email). "" when there are none. The caller
// sanitizes this like {{FROM}}/{{SUBJECT}}, since filenames/types are sender-controlled.
export function attachmentsNote(attachments: MailAttachment[]): string {
  if (attachments.length === 0) return "";
  const list = attachments.map((a) => `${a.filename || "attachment"} (${a.contentType || "unknown type"})`).join(", ");
  return `Attachments on the message to respond to: ${list}`;
}

// One selected attachment + its freshly-minted presigned url -> a BAXTER_MEDIA item the
// runner base64s (source:"email" -> buildMediaParts fetches the url; see runner-common).
export function toMailMediaItem(a: MailAttachment, downloadUrl: string): MediaItem {
  return {
    source: "email",
    url: downloadUrl,
    ...(a.contentType ? { content_type: a.contentType } : {}),
    ...(a.filename ? { filename: a.filename } : {}),
    size: a.size,
  };
}
