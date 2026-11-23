// SQL for the jobs table: save a job (idempotently by its link), find one, move its status (with the
// history row, under a row lock) and list jobs with their latest fit scores.
import { inTransaction, type Queryable } from "./database.js";
import type { JobStatus, Recommendation, SourceKind } from "./lookups.js";
import { INITIAL_JOB_STATUS } from "../domain/job-status.js";

/** A job to save, already validated and normalised. */
export interface NewJob {
  /** The canonical job link; null for pasted text. */
  sourceUrl: string | null;
  sourceKind: SourceKind;
  title: string | null;
  company: string | null;
  location: string | null;
  payText: string | null;
  description: string;
}

export interface SavedJob extends NewJob {
  id: number;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveJobResult {
  job: SavedJob;
  /** false when a job with the same link was already saved (and is returned instead). */
  created: boolean;
}

interface JobRow {
  // bigint columns come back from pg as strings (they can exceed JavaScript's safe integers);
  // job ids never get near 2^53, so they are turned into numbers.
  id: string;
  source_url: string | null;
  source_kind: SourceKind;
  title: string | null;
  company: string | null;
  location: string | null;
  pay_text: string | null;
  description: string;
  status: JobStatus;
  created_at: Date;
  updated_at: Date;
}

const JOB_COLUMNS =
  "id, source_url, source_kind, title, company, location, pay_text, description, status, created_at, updated_at";

const toSaved = (row: JobRow): SavedJob => ({
  id: Number(row.id),
  sourceUrl: row.source_url,
  sourceKind: row.source_kind,
  title: row.title,
  company: row.company,
  location: row.location,
  payText: row.pay_text,
  description: row.description,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Saves `job` with status 'saved' and its first job_status_history row, in ONE transaction
 * (jobs.status is a copy of the latest history row, so the two are always written together).
 *
 * Idempotent by link: if a job with the same source_url exists, nothing is written and that job
 * is returned with `created: false`. Pasted jobs (source_url NULL) are always new.
 *
 * Two saves of the same link at the same moment: INSERT ... ON CONFLICT DO NOTHING makes the
 * second one wait for the first to commit and then insert nothing; it then reads the first one's
 * row. So there is never a duplicate, and never a unique-violation error to retry.
 */
export async function saveJob(db: Queryable, job: NewJob): Promise<SaveJobResult> {
  return inTransaction(db, async (tx) => {
    const inserted = await tx.query<JobRow>(
      `INSERT INTO jobs (source_url, source_kind, title, company, location, pay_text, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_url) DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
      [job.sourceUrl, job.sourceKind, job.title, job.company, job.location, job.payText, job.description, INITIAL_JOB_STATUS],
    );
    const row = inserted.rows[0];
    if (row) {
      await tx.query("INSERT INTO job_status_history (job_id, to_status) VALUES ($1, $2)", [row.id, INITIAL_JOB_STATUS]);
      return { job: toSaved(row), created: true };
    }

    // Nothing inserted: the link is already saved. (Only a non-NULL source_url can conflict.)
    const existing = job.sourceUrl === null ? undefined : await findJobBySourceUrl(tx, job.sourceUrl);
    if (!existing) throw new Error("A job with this link was neither inserted nor found."); // can't happen
    return { job: existing, created: false };
  });
}

/** The job saved with this exact (canonical) link, or `undefined`. */
export async function findJobBySourceUrl(db: Queryable, sourceUrl: string): Promise<SavedJob | undefined> {
  const result = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE source_url = $1`, [sourceUrl]);
  const row = result.rows[0];
  return row ? toSaved(row) : undefined;
}

/** The job with this id, or `undefined`. */
export async function getJobById(db: Queryable, id: number): Promise<SavedJob | undefined> {
  const result = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toSaved(row) : undefined;
}

/** One row of a job's status paper trail. */
export interface StatusHistoryEntry {
  status: JobStatus;
  note: string | null;
  changedAt: Date;
}

/** The job's status changes, oldest first: (created_at, id), id breaking timestamp ties (migration 001). */
export async function getStatusHistory(db: Queryable, jobId: number): Promise<StatusHistoryEntry[]> {
  const result = await db.query<{ to_status: JobStatus; note: string | null; created_at: Date }>(
    "SELECT to_status, note, created_at FROM job_status_history WHERE job_id = $1 ORDER BY created_at, id",
    [jobId],
  );
  return result.rows.map((row) => ({ status: row.to_status, note: row.note, changedAt: row.created_at }));
}

export type MoveJobResult =
  | { ok: true; job: SavedJob; from: JobStatus; entry: StatusHistoryEntry }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "refused"; message: string };

/**
 * Moves a job to `to`: one job_status_history row (with `note`) and jobs.status, in ONE transaction
 * (jobs.status is a copy of the latest history row).
 *
 * `decide` gets the job's CURRENT status and says whether the move is allowed (the rules are in
 * src/domain/job-status.ts). The job row is locked first (SELECT ... FOR NO KEY UPDATE), so two
 * moves of the same job at the same moment run one after the other: the second waits for the
 * first to commit and is judged from ITS result. Without the lock both would read the old status,
 * both could pass, and the history could hold a move the rules forbid (e.g. applied → go).
 *
 * NO KEY UPDATE rather than UPDATE (review R3): a status change never touches the job's id, so it
 * need not wait for rows that merely REFERENCE the job, such as a save_fit insert in progress
 * (the foreign key check takes a KEY SHARE lock, which FOR UPDATE would wait for). Two moves still
 * exclude each other, because NO KEY UPDATE conflicts with itself. It is also the lock Postgres
 * takes for the UPDATE below, so the transaction never has to upgrade its lock.
 */
export async function moveJobStatus(
  db: Queryable,
  move: { id: number; to: JobStatus; note: string | null },
  decide: (from: JobStatus) => { ok: true } | { ok: false; message: string },
): Promise<MoveJobResult> {
  return inTransaction(db, async (tx) => {
    const locked = await tx.query<{ status: JobStatus }>("SELECT status FROM jobs WHERE id = $1 FOR NO KEY UPDATE", [move.id]);
    const current = locked.rows[0];
    if (!current) return { ok: false, reason: "not_found" };
    const decision = decide(current.status);
    if (!decision.ok) return { ok: false, reason: "refused", message: decision.message };

    // clock_timestamp(), not now(): now() is when the TRANSACTION began, so a move that waited on
    // the lock would get an earlier time than the move it waited for, and "the latest history row"
    // (ordered by created_at, id) would disagree with jobs.status. Taken after the lock, the clock
    // follows the order the moves really happened in (the race test in job-tools.test.ts found this).
    const inserted = await tx.query<{ created_at: Date }>(
      `INSERT INTO job_status_history (job_id, to_status, note, created_at) VALUES ($1, $2, $3, clock_timestamp())
       RETURNING created_at`,
      [move.id, move.to, move.note],
    );
    const updated = await tx.query<JobRow>(
      `UPDATE jobs SET status = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING ${JOB_COLUMNS}`,
      [move.id, move.to],
    );
    const row = updated.rows[0];
    const changedAt = inserted.rows[0]?.created_at;
    if (!row || !changedAt) throw new Error("The status change returned no row."); // can't happen: the row is locked
    return { ok: true, job: toSaved(row), from: current.status, entry: { status: move.to, note: move.note, changedAt } };
  });
}

/** A row of list_jobs: the job and its latest fit check's scores (null when it has none). */
export interface JobListRow {
  id: number;
  title: string | null;
  company: string | null;
  status: JobStatus;
  updatedAt: Date;
  jdMatchPct: number | null;
  /** Employer view (step 11); null when the job has no fit check, or its latest one predates step 11. */
  strictJdMatchPct: number | null;
  criteriaMatchPct: number | null;
  recommendation: Recommendation | null;
  /** null when the job has no fit check, or its latest one was saved before the flag existed. */
  weakGo: boolean | null;
}

/**
 * One page of jobs, most recently changed first (updated_at, then the newest id), optionally of
 * one status, each with its LATEST fit check (created_at, then id) joined in. `total` is how many
 * jobs match the filter, counted in the same statement so the page and the total agree.
 *
 * The page is sorted and cut FIRST, reading only the columns it shows (never the description),
 * and the latest fit is looked up for those rows only (review R2). Migration 003's indexes serve
 * both: (updated_at DESC, id DESC) for the page, (job_id, created_at DESC, id DESC) for each fit.
 */
export async function listJobs(
  db: Queryable,
  options: { status: JobStatus | null; limit: number; offset: number },
): Promise<{ rows: JobListRow[]; total: number }> {
  const result = await db.query<{
    id: string | null;
    title: string | null;
    company: string | null;
    status: JobStatus | null;
    updated_at: Date | null;
    jd_match_pct: string | null;
    strict_jd_match_pct: string | null;
    criteria_match_pct: string | null;
    recommendation: Recommendation | null;
    weak_go: boolean | null;
    total: string;
  }>(
    // The count is the LEFT side, so an empty page still returns one row (all NULL but total).
    `SELECT p.id, p.title, p.company, p.status, p.updated_at,
            f.jd_match_pct, f.strict_jd_match_pct, f.criteria_match_pct, f.recommendation, f.weak_go, counted.total
     FROM (SELECT count(*) AS total FROM jobs WHERE $1::text IS NULL OR status = $1) counted
     LEFT JOIN (
       SELECT id, title, company, status, updated_at
       FROM jobs
       WHERE $1::text IS NULL OR status = $1
       ORDER BY updated_at DESC, id DESC
       LIMIT $2 OFFSET $3
     ) p ON true
     LEFT JOIN LATERAL (
       SELECT jd_match_pct, strict_jd_match_pct, criteria_match_pct, recommendation, weak_go
       FROM fit_checks WHERE job_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1
     ) f ON true
     ORDER BY p.updated_at DESC, p.id DESC`,
    [options.status, options.limit, options.offset],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const rows: JobListRow[] = [];
  for (const row of result.rows) {
    if (row.id === null || row.status === null || row.updated_at === null) continue; // the empty-page row
    rows.push({
      id: Number(row.id),
      title: row.title,
      company: row.company,
      status: row.status,
      updatedAt: row.updated_at,
      jdMatchPct: row.jd_match_pct === null ? null : Number(row.jd_match_pct),
      strictJdMatchPct: row.strict_jd_match_pct === null ? null : Number(row.strict_jd_match_pct),
      criteriaMatchPct: row.criteria_match_pct === null ? null : Number(row.criteria_match_pct),
      recommendation: row.recommendation,
      weakGo: row.weak_go,
    });
  }
  return { rows, total };
}
