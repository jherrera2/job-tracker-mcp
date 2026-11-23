// Reads one job from its ATS: fetch the API URL (guarded), then hand the JSON to that ATS's adapter.
import { countChars } from "../domain/master-resume.js";
import { readAshbyBoard } from "./ashby.js";
import { readGreenhouseJob } from "./greenhouse.js";
import type { JobPosting } from "./job-posting.js";
import type { JobSource, LinkedSourceKind } from "./job-url.js";
import { readLeverPosting } from "./lever.js";
import { fetchJson, JobSourceError, SOURCE_MESSAGES, type FetchFn } from "./safe-fetch.js";

/** Same ceiling as pasted text (PRD 01 §2 story 3), so a fetched job fits the same fit-check prompt. */
export const MAX_FETCHED_DESCRIPTION_CHARS = 50_000;

// Record<LinkedSourceKind, ...> must have an adapter for every kind, or it won't compile.
const READERS: Record<LinkedSourceKind, (json: unknown, source: JobSource) => JobPosting> = {
  greenhouse: readGreenhouseJob,
  lever: readLeverPosting,
  ashby: readAshbyBoard,
};

export interface FetchPostingOptions {
  fetch?: FetchFn;
}

/** The job behind `source`, normalised. Throws JobSourceError with a message for the user. */
export async function fetchJobPosting(source: JobSource, options: FetchPostingOptions = {}): Promise<JobPosting> {
  const json = await fetchJson(source.apiUrl, { fetch: options.fetch });
  const posting = READERS[source.kind](json, source);
  if (posting.description === "") throw new JobSourceError(SOURCE_MESSAGES.noDescription);
  if (countChars(posting.description) > MAX_FETCHED_DESCRIPTION_CHARS) {
    throw new JobSourceError(SOURCE_MESSAGES.descriptionTooLong);
  }
  return posting;
}
