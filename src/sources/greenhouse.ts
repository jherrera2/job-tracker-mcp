// Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?pay_transparency=true
// (public Job Board API, no key). `content` is HTML that is ITSELF entity-encoded ("&lt;p&gt;"),
// so it is decoded once before the tags are removed. Pay comes from pay_input_ranges, whose
// "min_cents"/"max_cents" are in the currency's MINOR unit: hundredths for USD, EUR, GBP, INR, but
// whole yen for JPY (a live Tokyo posting sent 17178000 for a ¥17.2M salary, 2026-11-19). Each
// range keeps its `blurb` (a note such as "per hour" or who the range applies to), shortened.
import { z } from "zod";
import { cleanDecodedLine, cleanLine, decodeEntities, htmlToText, truncateChars } from "./html-to-text.js";
import { formatRange, joinPresent, parseOrUnreadable, type JobPosting } from "./job-posting.js";
import type { JobSource } from "./job-url.js";

// A blurb is often a whole paragraph; this much keeps its point and leaves room for a second range
// within the 300-character pay line.
const MAX_BLURB_CHARS = 100;

/** Digits after the decimal point in `currency` (USD 2, JPY 0, BHD 3); 2 for a code Intl rejects. */
function minorUnitDigits(currency: string | null | undefined): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    return 2; // not an ISO 4217 code: assume hundredths, like most currencies
  }
}

const GreenhouseJob = z.object({
  title: z.string(),
  company_name: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string(),
  pay_input_ranges: z
    .array(
      z.object({
        min_cents: z.number().nullish(),
        max_cents: z.number().nullish(),
        currency_type: z.string().nullish(),
        title: z.string().nullish(),
        blurb: z.string().nullish(),
      }),
    )
    .nullish(),
});

// Same signature as the other adapters (see READERS in fetch-posting.ts); Greenhouse's answer
// carries everything itself, so the source isn't needed.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function readGreenhouseJob(json: unknown, _source: JobSource): JobPosting {
  const job = parseOrUnreadable(GreenhouseJob, json);
  const pay = (job.pay_input_ranges ?? []).map((range) => {
    const scale = 10 ** minorUnitDigits(range.currency_type);
    const toUnits = (minor: number | null | undefined) => (typeof minor === "number" ? minor / scale : null);
    const amount = formatRange(toUnits(range.min_cents), toUnits(range.max_cents), range.currency_type);
    if (!amount) return null;
    const label = cleanLine(range.title)?.replace(/\s*:$/, ""); // "Salary Range: " → "Salary Range"
    const blurb = range.blurb ? cleanDecodedLine(htmlToText(range.blurb)) : null; // htmlToText decoded it
    const text = label ? `${label}: ${amount}` : amount;
    return blurb ? `${text} (${truncateChars(blurb, MAX_BLURB_CHARS)})` : text;
  });
  return {
    title: cleanLine(job.title),
    company: cleanLine(job.company_name),
    location: cleanLine(job.location?.name),
    payText: cleanDecodedLine(joinPresent(pay, "; ")), // its parts are already decoded
    description: htmlToText(decodeEntities(job.content)),
  };
}
