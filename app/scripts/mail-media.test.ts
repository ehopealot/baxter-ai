// Tests for the pure email-media helpers (selection, prompt marker, BAXTER_MEDIA item shape).
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMailMedia, attachmentsNote, toMailMediaItem } from "./mail-media.ts";
import type { MailAttachment } from "./mail-media.ts";

const att = (o: Partial<MailAttachment> & { attachmentId: string }): MailAttachment => ({ size: 10, ...o });

test("selectMailMedia keeps ONLY the runner-forwardable types (image/audio/pdf, not video), and caps", () => {
  const atts = [
    att({ attachmentId: "1", contentType: "image/png", filename: "a.png" }),
    att({ attachmentId: "2", contentType: "application/pdf", filename: "b.pdf" }),
    att({ attachmentId: "3", contentType: "text/plain", filename: "c.txt" }),   // dropped
    att({ attachmentId: "4", contentType: "application/zip", filename: "d.zip" }), // dropped
    att({ attachmentId: "5", contentType: "audio/mpeg", filename: "e.mp3" }),
    att({ attachmentId: "6", contentType: "video/mp4", filename: "f.mp4" }),     // dropped: video out for email v1 (runner drops it too)
  ];
  assert.deepEqual(selectMailMedia(atts, 10).map((a) => a.attachmentId), ["1", "2", "5"]);
  assert.deepEqual(selectMailMedia(atts, 2).map((a) => a.attachmentId), ["1", "2"]); // capped
  assert.deepEqual(selectMailMedia(atts, 0), []); // cap 0 -> none
  assert.deepEqual(selectMailMedia([], 4), []);
  // a missing contentType isn't forwardable
  assert.deepEqual(selectMailMedia([att({ attachmentId: "x" })], 4), []);
});

test("attachmentsNote lists ALL attachments (incl. non-forwardable), or '' when none", () => {
  assert.equal(attachmentsNote([]), "");
  const note = attachmentsNote([
    att({ attachmentId: "1", contentType: "image/png", filename: "cat.png" }),
    att({ attachmentId: "2", contentType: "application/zip", filename: "logs.zip" }), // still listed
    att({ attachmentId: "3", size: 5 }), // no filename/type -> generic
  ]);
  assert.match(note, /cat\.png \(image\/png\)/);
  assert.match(note, /logs\.zip \(application\/zip\)/); // a non-forwardable type is still surfaced
  assert.match(note, /attachment \(unknown type\)/);
});

test("toMailMediaItem builds a source:email BAXTER_MEDIA item carrying the presigned url", () => {
  const item = toMailMediaItem(att({ attachmentId: "1", contentType: "image/png", filename: "cat.png", size: 99 }), "https://dl.example/att?sig=x");
  assert.deepEqual(item, { source: "email", url: "https://dl.example/att?sig=x", content_type: "image/png", filename: "cat.png", size: 99 });
  // absent filename/type are omitted (not set to undefined), size still carried
  assert.deepEqual(toMailMediaItem(att({ attachmentId: "2", size: 3 }), "https://dl.example/y"), { source: "email", url: "https://dl.example/y", size: 3 });
});
