// Job link → which ATS it is, and the API address to read it from (PRD 01 §2 story 3, §6).
//
// Only Greenhouse, Lever and Ashby job links are accepted. Everything else (LinkedIn, Indeed, a
// company's own careers page...) gets CANT_READ_SITE and nothing is fetched: v1 does no general
// web fetching.
//
// The API URL is BUILT here from two small pieces of the link: the company's board name (checked
// against a strict pattern) and the job id (digits or a UUID). The host comes from our own
// constants, so whatever the user sends can't make the server fetch another address (SSRF).
//
// Each source also gets a canonical `sourceUrl` (tracking parameters, "/apply" and the like
// removed, the board name lowercased, Greenhouse ids without leading zeros), which is what the jobs table stores: the same job reached through two link shapes is
// still one job.
import type { SourceKind } from "../db/lookups.js";
import type { ParseResult } from "../domain/master-resume.js";
import { SOURCE_MESSAGES, isAllowedApiUrl } from "./safe-fetch.js";

/** Kinds of job source that are read from a link (everything except pasted text). */
export type LinkedSourceKind = Exclude<SourceKind, "paste">;

export interface JobSource {
  kind: LinkedSourceKind;
  /** The canonical job link, stored as jobs.source_url. */
  sourceUrl: string;
  /** The public API URL this job is read from (always an allowlisted HTTPS host). */
  apiUrl: string;
  /** The company's board name in the ATS ("acme" in jobs.lever.co/acme/...). */
  slug: string;
  /** The job's id in the ATS (digits for Greenhouse, a lowercase UUID for Lever and Ashby). */
  jobId: string;
}

export const CANT_READ_SITE = SOURCE_MESSAGES.notAllowed;
export const NOT_ONE_JOB =
  "That link is a list of jobs, not one job. Open the job and copy its link, or paste the job description text.";

const MAX_URL_CHARS = 2_000;
// A board name: letters, digits, dot, dash, underscore; starts with a letter or digit (so "." and
// ".." are impossible). No "/", "%", "@", "?" or "#", so it can't change the API path.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GREENHOUSE_ID = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Detection = ParseResult<{ source: JobSource }>;
const fail = (message: string): Detection => ({ ok: false, message });

export function detectJobSource(input: string): Detection {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_CHARS) return fail(CANT_READ_SITE);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail(CANT_READ_SITE);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail(CANT_READ_SITE);

  // URL has already lowercased the host and resolved "." and ".." path segments.
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  switch (url.hostname) {
    case "boards.greenhouse.io":
    case "job-boards.greenhouse.io":
      return greenhouse(url, segments);
    case "jobs.lever.co":
      return lever(segments, "jobs.lever.co", "api.lever.co");
    case "jobs.eu.lever.co":
      return lever(segments, "jobs.eu.lever.co", "api.eu.lever.co");
    case "jobs.ashbyhq.com":
      return ashby(segments);
    default:
      return fail(CANT_READ_SITE);
  }
}

/** boards.greenhouse.io/<board>/jobs/<id>, or the embed form /embed/job_app?for=<board>&token=<id>. */
function greenhouse(url: URL, segments: string[]): Detection {
  let slug: string | undefined;
  let jobId: string | undefined;
  if (segments[0] === "embed") {
    if (segments[1] !== "job_app") return fail(NOT_ONE_JOB);
    slug = url.searchParams.get("for") ?? undefined;
    jobId = url.searchParams.get("token") ?? undefined;
  } else {
    slug = segments[0];
    if (segments.length === 3 && segments[1] === "jobs") jobId = segments[2];
  }
  if (slug !== undefined && !SLUG.test(slug)) return fail(CANT_READ_SITE);
  if (slug === undefined || jobId === undefined || !GREENHOUSE_ID.test(jobId)) return fail(NOT_ONE_JOB);
  // Greenhouse's API ignores board-name case and zero padding (checked live 2026-11-19), so both are
  // normalised in the stored link AND the API call: "Acme/jobs/0012" and "acme/jobs/12" are one job.
  slug = slug.toLowerCase();
  jobId = jobId.replace(/^0+(?=\d)/, "");

  return found({
    kind: "greenhouse",
    sourceUrl: `https://job-boards.greenhouse.io/${slug}/jobs/${jobId}`,
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?pay_transparency=true`,
    slug,
    jobId,
  });
}

/** jobs.lever.co/<site>/<uuid>[/apply] (and the EU twin). */
function lever(segments: string[], jobsHost: string, apiHost: string): Detection {
  const parsed = slugAndUuid(segments, "apply");
  if (!parsed.ok) return parsed;
  const { slug, jobId } = parsed;
  // Lever's API is case-sensitive ("Palantir" 404s where "palantir" works, 2026-11-19), so it is
  // called with the name exactly as linked; only the stored link is lowercased, for de-duplication.
  return found({
    kind: "lever",
    sourceUrl: `https://${jobsHost}/${slug.toLowerCase()}/${jobId}`,
    apiUrl: `https://${apiHost}/v0/postings/${slug}/${jobId}`,
    slug,
    jobId,
  });
}

/**
 * jobs.ashbyhq.com/<org>/<uuid>[/application]. Ashby's public posting API only serves a whole
 * board, so the API URL is the board; the adapter picks the job out by id.
 */
function ashby(segments: string[]): Detection {
  const parsed = slugAndUuid(segments, "application");
  if (!parsed.ok) return parsed;
  // Ashby's API ignores case (checked live 2026-11-19), so the name is lowercased everywhere.
  const slug = parsed.slug.toLowerCase();
  const { jobId } = parsed;
  return found({
    kind: "ashby",
    sourceUrl: `https://jobs.ashbyhq.com/${slug}/${jobId}`,
    apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    slug,
    jobId,
  });
}

function slugAndUuid(segments: string[], optionalSuffix: string): ParseResult<{ slug: string; jobId: string }> {
  const [slug, id, suffix, ...rest] = segments;
  if (slug === undefined) return { ok: false, message: NOT_ONE_JOB };
  if (!SLUG.test(slug)) return { ok: false, message: CANT_READ_SITE };
  const shapeOk = rest.length === 0 && (suffix === undefined || suffix === optionalSuffix);
  if (id === undefined || !UUID.test(id) || !shapeOk) return { ok: false, message: NOT_ONE_JOB };
  return { ok: true, slug, jobId: id.toLowerCase() };
}

function found(source: JobSource): Detection {
  // Belt and braces: what we just built must be on the allowlist (fetchJson checks again).
  if (!isAllowedApiUrl(new URL(source.apiUrl))) throw new Error(`Built a non-allowlisted API URL: ${source.apiUrl}`);
  return { ok: true, source };
}
