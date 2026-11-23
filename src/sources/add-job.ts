// Adding a job from a link or from pasted text (PRD 01 §2 story 3): the source layer and the save,
// which the add_job MCP tool calls (src/tools/job-tools.ts); add_job then points the chat model at
// get_fit_inputs, since the user's own model writes the fit check (ADR-001).
//
// From a link: detect the ATS → if that job is already saved, return it WITHOUT fetching again →
// otherwise read it through the guarded fetch and save it. A link we can't read, or a fetch that
// fails, returns a message for the user and saves nothing.
import type { Queryable } from "../db/database.js";
import { findJobBySourceUrl, saveJob, type SavedJob } from "../db/jobs-repo.js";
import { parsePastedJob, type PastedJobInput } from "../domain/job-paste.js";
import { fetchJobPosting } from "./fetch-posting.js";
import { detectJobSource, type JobSource } from "./job-url.js";
import { JobSourceError, type FetchFn } from "./safe-fetch.js";

export interface AddJobDeps {
  db: Queryable;
  /** Injected so tests use recorded fixtures; the server uses the global fetch. */
  fetch?: FetchFn;
}

export type AddJobResult = { ok: true; job: SavedJob; created: boolean } | { ok: false; message: string };

// Adds of a link already in progress, per database, keyed by flightKey ("single flight").
// A WeakMap so a database object that is gone (e.g. a test's connection) takes its entries with it.
const inFlight = new WeakMap<Queryable, Map<string, Promise<AddJobResult>>>();

/**
 * Two adds of the same job at the same moment make ONE request: the second waits for the first
 * and gets its result (as `created: false`). Without this, both would find nothing saved and both
 * would fetch; the database would still keep one job (saveJob), but the site would be asked twice.
 * In-process on purpose: v1 is one user over stdio, and holding a Postgres lock across a fetch
 * of up to 10 s would tie up a connection. Another process adding the same link at the same
 * moment may still fetch twice, and saveJob still stores one job.
 */
export async function addJobFromUrl(deps: AddJobDeps, url: string): Promise<AddJobResult> {
  const detected = detectJobSource(url);
  if (!detected.ok) return detected;
  const { source } = detected;

  let flights = inFlight.get(deps.db);
  if (!flights) {
    flights = new Map();
    inFlight.set(deps.db, flights);
  }
  const key = flightKey(source);
  const running = flights.get(key);
  if (running) {
    const result = await running;
    return result.ok ? { ...result, created: false } : result;
  }

  // Registered synchronously (no await between the check above and here), so a second call
  // always sees it. Removed once settled, so a failed add can be retried.
  const map = flights;
  const flight = addFromSource(deps, source).finally(() => map.delete(key));
  map.set(key, flight);
  return flight;
}

/**
 * Which adds share one request: those that would fetch the same thing. Usually the canonical
 * link, but Lever's API is case-sensitive while its stored link is lowercased, so a wrong-case
 * Lever link (which 404s) must not swallow a correct one: Lever is keyed by its exact API URL.
 * Two Lever adds that differ only in case may both fetch; saveJob still keeps one job.
 */
const flightKey = (source: JobSource): string => (source.kind === "lever" ? source.apiUrl : source.sourceUrl);

async function addFromSource(deps: AddJobDeps, source: JobSource): Promise<AddJobResult> {
  const existing = await findJobBySourceUrl(deps.db, source.sourceUrl);
  if (existing) return { ok: true, job: existing, created: false };

  let posting;
  try {
    posting = await fetchJobPosting(source, { fetch: deps.fetch });
  } catch (err) {
    if (err instanceof JobSourceError) return { ok: false, message: err.message };
    throw err;
  }
  const saved = await saveJob(deps.db, { sourceUrl: source.sourceUrl, sourceKind: source.kind, ...posting });
  return { ok: true, ...saved };
}

export async function addJobFromText(deps: Pick<AddJobDeps, "db">, input: PastedJobInput): Promise<AddJobResult> {
  const parsed = parsePastedJob(input);
  if (!parsed.ok) return parsed;
  const saved = await saveJob(deps.db, {
    sourceUrl: null,
    sourceKind: "paste",
    title: parsed.job.title,
    company: parsed.job.company,
    location: null,
    payText: null,
    description: parsed.job.text,
  });
  return { ok: true, ...saved };
}
