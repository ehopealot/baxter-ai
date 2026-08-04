// E.164 canonical form. MUST be byte-identical to core/app/scripts/normalize-phone.ts
// and baxctl/lib/normalize-phone.ts — any drift silently breaks tenant resolution.
export function normalizePhone(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (!digits) return null;
  let e164: string;
  if (hasPlus) e164 = "+" + digits;
  else if (digits.length === 10) e164 = "+1" + digits; // bare US 10-digit
  else e164 = "+" + digits;
  const n = e164.length - 1; // digit count, excluding the leading '+'
  if (n < 7 || n > 15) return null; // E.164 bounds
  return e164;
}
