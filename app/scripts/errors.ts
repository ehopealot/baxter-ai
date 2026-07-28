// Extract a human string from an unknown thrown value. Type-safe replacement for
// the `e?.message ?? e` idiom the catch handlers used before (the catch var is
// `unknown` under strict): a real Error, or any object carrying a non-null
// `message` (duck-typed, like the old idiom), yields that message; anything else
// stringifies. Kept faithful to the old behavior since it feeds error logs.
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (m != null) return String(m);
  }
  return String(e);
}
