// Lever: GET https://api.lever.co/v0/postings/<site>/<uuid> (public Postings API, no key; EU sites
// use api.eu.lever.co). The answer has no company name, so the site name from the link is used.
// The description is spread over several fields: the intro, titled lists, and a closing part.
import { z } from "zod";
import { cleanDecodedLine, cleanLine, htmlToText, normalizeText } from "./html-to-text.js";
import { formatRange, joinPresent, parseOrUnreadable, type JobPosting } from "./job-posting.js";
import type { JobSource } from "./job-url.js";

const LeverPosting = z.object({
  text: z.string(),
  categories: z.object({ location: z.string().nullish(), allLocations: z.array(z.string()).nullish() }).nullish(),
  descriptionPlain: z.string().nullish(),
  description: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additionalPlain: z.string().nullish(),
  additional: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
  salaryDescriptionPlain: z.string().nullish(),
});

/** Prefer the API's plain-text field; fall back to converting its HTML twin. */
const plainOrHtml = (plain: string | null | undefined, html: string | null | undefined): string =>
  plain ? normalizeText(plain) : html ? htmlToText(html) : "";

export function readLeverPosting(json: unknown, source: JobSource): JobPosting {
  const posting = parseOrUnreadable(LeverPosting, json);

  const lists = (posting.lists ?? []).map((list) =>
    joinPresent([normalizeText(list.text ?? ""), htmlToText(list.content ?? "")], "\n"),
  );
  const description = joinPresent(
    [plainOrHtml(posting.descriptionPlain, posting.description), ...lists, plainOrHtml(posting.additionalPlain, posting.additional)],
    "\n\n",
  );

  const allLocations = posting.categories?.allLocations ?? [];
  const location = allLocations.length > 0 ? allLocations.join("; ") : posting.categories?.location;

  return {
    title: cleanLine(posting.text),
    company: cleanLine(source.slug),
    location: cleanLine(location),
    payText: cleanDecodedLine(leverPay(posting)), // the interval is decoded in intervalText; the note is plain text
    description: normalizeText(description ?? ""),
  };
}

function leverPay(posting: z.infer<typeof LeverPosting>): string | null {
  const range = posting.salaryRange;
  const interval = intervalText(range?.interval);
  const amount = range ? formatRange(range.min, range.max, range.currency) : null;
  const stated = amount && interval ? `${amount} ${interval}` : amount;
  const note = posting.salaryDescriptionPlain ? normalizeText(posting.salaryDescriptionPlain) : null;
  return joinPresent([stated, note], ". ");
}

/**
 * "per-year-salary" → "per year", "per-hour-wage" → "per hour"; any other value is kept, just
 * made readable ("one-time" → "one time"), so an unusual interval is never silently dropped.
 */
function intervalText(interval: string | null | undefined): string | null {
  if (!interval) return null;
  const per = /^per-([a-z]+)/i.exec(interval)?.[1];
  if (per) return `per ${per.toLowerCase()}`;
  return cleanLine(interval.replace(/[-_]+/g, " "));
}
