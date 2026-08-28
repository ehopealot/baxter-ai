import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { syncDirectory } from "./durable-directory.ts";

/**
 * Repair the one crash tail an append-only JSONL file may expose. Callers must
 * hold the file's cross-process lock. A complete JSON value gets its missing
 * newline; an incomplete value is truncated to the preceding newline.
 */
export function repairPartialJsonlTail(path: string): string {
  let raw = readFileSync(path, "utf8");
  if (raw === "" || raw.endsWith("\n")) return raw;
  const boundary = raw.lastIndexOf("\n") + 1;
  const tail = raw.slice(boundary);
  let complete = false;
  try { JSON.parse(tail); complete = true; } catch {}
  const fd = openSync(path, "r+");
  try {
    if (complete) {
      const newline = Buffer.from("\n");
      const position = Buffer.byteLength(raw);
      const written = writeSync(fd, newline, 0, newline.length, position);
      if (written !== newline.length) throw new Error("JSONL tail repair made no progress");
      raw += "\n";
    } else {
      const prefix = raw.slice(0, boundary);
      ftruncateSync(fd, Buffer.byteLength(prefix));
      raw = prefix;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
  return raw;
}
