// SQL for the fit_checks table: one row per saved fit check, and the latest one for a job. Rows are
// only ever added, so re-runs sit side by side and a fit check from before a prompt edit can be
// compared with one after it.
import type { Queryable } from "./database.js";
import type { Recommendation } from "./lookups.js";

/** A fit check to store, already validated, quote-checked and scored by code. */
export interface NewFitCheck {
  jobId: number;
  promptVersion: number;
  masterResumeVersion: number;
  /** As reported by the chat app; unverified. null when it reported nothing. */
  model: string | null;
  /** The answer as stored: the cleaned answer plus the quotes the check dropped. */
  resultJson: Record<string, unknown>;
  jdMatchPct: number;
  /** Employer view: % of requirements "met" only (step 11, src/domain/fit-score.ts). */
  strictJdMatchPct: number;
  criteriaMatchPct: number | null;
  recommendation: Recommendation;
  /** How many evidence quotes the word-for-word check dropped. */
  quotesDropped: number;
  /** How many make_explicit suggestions the same check dropped (step 11). */
  suggestionsDropped: number;
  /** The model said "go" but the JD match is under 50 % after the check (src/domain/fit-score.ts). */
  weakGo: boolean;
}

export interface SavedFitCheck {
  id: number;
  createdAt: Date;
}

/**
 * Inserts the row. latency_ms and the token counts stay NULL: the chat model ran in the user's
 * app, so the server never saw how long it took or what it cost (migration 002).
 */
export async function saveFitCheck(db: Queryable, fit: NewFitCheck): Promise<SavedFitCheck> {
  const result = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO fit_checks
       (job_id, prompt_version, master_resume_version, model, result_json, jd_match_pct, criteria_match_pct, recommendation,
        quotes_dropped, weak_go, strict_jd_match_pct, suggestions_dropped)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, created_at`,
    [
      fit.jobId,
      fit.promptVersion,
      fit.masterResumeVersion,
      fit.model,
      // pg would send a JS object as JSON anyway; stringifying here makes that explicit.
      JSON.stringify(fit.resultJson),
      fit.jdMatchPct,
      fit.criteriaMatchPct,
      fit.recommendation,
      fit.quotesDropped,
      fit.weakGo,
      fit.strictJdMatchPct,
      fit.suggestionsDropped,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Saving the fit check returned no row."); // can't happen: INSERT ... RETURNING
  return { id: Number(row.id), createdAt: row.created_at };
}

/**
 * A stored fit check as get_job / add_job show it. Columns added in migration 002 (and 004, step 11)
 * are null on older rows.
 */
export interface StoredFitCheck {
  id: number;
  jobId: number;
  promptVersion: number;
  masterResumeVersion: number | null;
  model: string | null;
  resultJson: unknown;
  jdMatchPct: number;
  /** null = saved before step 11. */
  strictJdMatchPct: number | null;
  criteriaMatchPct: number | null;
  recommendation: Recommendation;
  quotesDropped: number | null;
  /** null = saved before step 11. */
  suggestionsDropped: number | null;
  weakGo: boolean | null;
  createdAt: Date;
}

/** The job's newest fit check (created_at, then id), or `undefined` when it has none. */
export async function getLatestFitCheck(db: Queryable, jobId: number): Promise<StoredFitCheck | undefined> {
  const result = await db.query<{
    id: string;
    job_id: string;
    prompt_version: number;
    master_resume_version: number | null;
    model: string | null;
    result_json: unknown;
    jd_match_pct: string;
    criteria_match_pct: string | null;
    recommendation: Recommendation;
    quotes_dropped: number | null;
    weak_go: boolean | null;
    strict_jd_match_pct: string | null;
    suggestions_dropped: number | null;
    created_at: Date;
  }>(
    `SELECT id, job_id, prompt_version, master_resume_version, model, result_json, jd_match_pct, criteria_match_pct,
            recommendation, quotes_dropped, weak_go, strict_jd_match_pct, suggestions_dropped, created_at
     FROM fit_checks WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    promptVersion: row.prompt_version,
    masterResumeVersion: row.master_resume_version,
    model: row.model,
    resultJson: row.result_json,
    // numeric(5,2) comes back from pg as a string (exact decimal); 2 decimals fit a JS number exactly enough.
    jdMatchPct: Number(row.jd_match_pct),
    strictJdMatchPct: row.strict_jd_match_pct === null ? null : Number(row.strict_jd_match_pct),
    criteriaMatchPct: row.criteria_match_pct === null ? null : Number(row.criteria_match_pct),
    recommendation: row.recommendation,
    quotesDropped: row.quotes_dropped,
    suggestionsDropped: row.suggestions_dropped,
    weakGo: row.weak_go,
    createdAt: row.created_at,
  };
}
