// Ashby: GET https://api.ashbyhq.com/posting-api/job-board/<org>?includeCompensation=true (public
// Posting API, no key). It only serves the WHOLE board, so the job is picked out by its id. The
// documented job object has no `id` field, only `jobUrl` (https://jobs.ashbyhq.com/<org>/<uuid>),
// so the id is read from jobUrl; the `id` the live API also sends today is the fallback. Only
// that one job is validated, so an odd entry elsewhere on the board doesn't block it. The answer
// has no company name, so the board name from the link is used.
import { z } from "zod";
import { cleanDecodedLine, cleanLine, htmlToText, normalizeText } from "./html-to-text.js";
import { joinPresent, parseOrUnreadable, type JobPosting } from "./job-posting.js";
import type { JobSource } from "./job-url.js";
import { JobSourceError, SOURCE_MESSAGES } from "./safe-fetch.js";

const AshbyBoard = z.object({ jobs: z.array(z.unknown()) });

const AshbyJob = z.object({
  id: z.string().nullish(),
  jobUrl: z.string().nullish(),
  title: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  compensation: z
    .object({
      compensationTierSummary: z.string().nullish(),
      scrapeableCompensationSalarySummary: z.string().nullish(),
    })
    .nullish(),
});

/** True when a board entry is the job with this (lowercase) id: by its jobUrl, else by `id`. */
function isJob(entry: unknown, id: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  if ("jobUrl" in entry && typeof entry.jobUrl === "string") {
    try {
      return new URL(entry.jobUrl).pathname.split("/").some((segment) => segment.toLowerCase() === id);
    } catch {
      // not a URL: fall through to `id`
    }
  }
  return "id" in entry && typeof entry.id === "string" && entry.id.toLowerCase() === id;
}

export function readAshbyBoard(json: unknown, source: JobSource): JobPosting {
  const board = parseOrUnreadable(AshbyBoard, json);
  const entry = board.jobs.find((candidate) => isJob(candidate, source.jobId));
  if (entry === undefined) throw new JobSourceError(SOURCE_MESSAGES.notFound);
  const job = parseOrUnreadable(AshbyJob, entry);

  // A Set removes repeats in linear time and keeps first-seen order (indexOf per item was quadratic).
  const locations = [
    ...new Set(
      [job.location, ...(job.secondaryLocations ?? []).map((s) => s.location)]
        .map((l) => cleanLine(l))
        .filter((l): l is string => l !== null),
    ),
  ];

  return {
    title: cleanLine(job.title),
    company: cleanLine(source.slug),
    location: cleanDecodedLine(joinPresent(locations, "; ")), // each part is decoded; the joined list can pass 300 characters
    payText: cleanLine(
      job.compensation?.compensationTierSummary ?? job.compensation?.scrapeableCompensationSalarySummary,
    ),
    description: job.descriptionPlain ? normalizeText(job.descriptionPlain) : htmlToText(job.descriptionHtml ?? ""),
  };
}
