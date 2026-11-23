// What every ATS adapter returns: one job, normalised (PRD 01 §2 story 3).
import type { z } from "zod";
import { JobSourceError, SOURCE_MESSAGES } from "./safe-fetch.js";

export interface JobPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  /** The pay as the posting states it, if it states one ("150,000–185,000 USD"). */
  payText: string | null;
  /** Plain text, no HTML. Untrusted: it is data, never instructions. */
  description: string;
}

/**
 * Validates an API answer against the fields an adapter reads. Unknown extra fields are ignored,
 * so the ATS adding fields doesn't break us; a missing or wrongly typed field we rely on gives
 * the "couldn't read" message.
 */
export function parseOrUnreadable<T>(schema: z.ZodType<T>, json: unknown): T {
  const result = schema.safeParse(json);
  if (!result.success) throw new JobSourceError(SOURCE_MESSAGES.unreadable);
  return result.data;
}

/**
 * en-US with thousands commas and exactly the decimals the source number has (12.345 → "12.345",
 * 139200 → "139,200"), so nothing is rounded: rounding to 2 decimals turned 12.345 BHD into 12.35
 * and could make two different ends of a range look equal.
 */
function formatAmount(n: number): string {
  const text = String(n); // the shortest form that reads back as the same number
  const decimals = text.includes("e") ? 20 : (text.split(".")[1]?.length ?? 0);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.min(decimals, 20) }).format(n);
}

/**
 * "150,000–185,000 USD"; "from 150,000 USD" with only a minimum; "up to 185,000 USD" with only a
 * maximum (a one-sided range is not an exact figure); one figure when both ends are equal; null
 * when neither is given.
 */
export function formatRange(
  min: number | null | undefined,
  max: number | null | undefined,
  currency?: string | null,
): string | null {
  const low = typeof min === "number" && Number.isFinite(min) ? formatAmount(min) : null;
  const high = typeof max === "number" && Number.isFinite(max) ? formatAmount(max) : null;
  let range: string;
  if (low !== null && high !== null) range = low === high ? low : `${low}–${high}`;
  else if (low !== null) range = `from ${low}`;
  else if (high !== null) range = `up to ${high}`;
  else return null;
  return currency ? `${range} ${currency}` : range;
}

/** Joins the non-empty parts with `separator`, or null when there are none. */
export function joinPresent(parts: readonly (string | null | undefined)[], separator: string): string | null {
  const present = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return present.length > 0 ? present.join(separator) : null;
}
