// Shared HTTP helpers for the scoped CLIs (web-cli, data-cli, skills-cli), so the
// response-cap logic lives in one place instead of drifting across three copies.

// Cap a fetch Response body WHILE reading it: stream and cancel the reader once
// hardMax bytes have arrived, so a hostile or slow server can't buffer unbounded
// memory before an after-the-fact slice. Reader-less responses (test stubs) fall
// back to arrayBuffer() or text(), whichever the stub exposes. Returns { text,
// truncated } with text decoded from at most hardMax bytes.
export async function readCapped(res, hardMax) {
  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(Buffer.from(value));
      if (total >= hardMax) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
    return { text: Buffer.concat(chunks).subarray(0, hardMax).toString("utf8"), truncated };
  }
  const raw = typeof res.arrayBuffer === "function"
    ? Buffer.from(await res.arrayBuffer())
    : Buffer.from(String(await res.text()), "utf8");
  return { text: raw.subarray(0, hardMax).toString("utf8"), truncated: raw.length > hardMax };
}
