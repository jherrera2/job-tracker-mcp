// Which status moves are allowed. Business rules live here in code (not in the database);
// the set_status tool enforces them (step 7, src/tools/job-tools.ts).
import { JOB_STATUSES, type JobStatus } from "../db/lookups.js";
import { countChars, formatNumber, hasVisibleChar, isPlainText, type ParseResult } from "./master-resume.js";

// Record<JobStatus, ...> is like a Dictionary<JobStatus, ...> that the compiler forces to have
// a key for EVERY status, so adding a status without deciding its moves won't compile.
// What the end states mean:
//   skip   = passed on it BEFORE applying. Not final: you may revisit (go) or apply later.
//   closed = it ended AFTER applying, so only applied / interviewing / offer can move to it.
export const ALLOWED_MOVES: Record<JobStatus, readonly JobStatus[]> = {
  saved: ["go", "skip", "applied"],
  go: ["skip", "applied"],
  skip: ["go", "applied"],
  applied: ["interviewing", "closed"],
  interviewing: ["offer", "closed"],
  offer: ["closed"],
  closed: [],
};

export function canMove(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_MOVES[from].includes(to);
}

/** The status every new job starts in, written with its first job_status_history row. */
export const INITIAL_JOB_STATUS: JobStatus = "saved";

// ---- set_status and list_jobs input rules (step 7). Pure code: test/unit/job-status.test.ts. ----

export const MAX_STATUS_NOTE_CHARS = 500;

/** Not repeating what was sent: a status is a short word, and the list says what is accepted. */
export const UNKNOWN_STATUS = `There is no status with that name. The statuses are: ${JOB_STATUSES.join(", ")}.`;

export const SKIP_NEEDS_NOTE =
  `Skipping needs a reason. Send a note (1 to ${MAX_STATUS_NOTE_CHARS} characters) saying why you're passing on this job, ` +
  "so you can see later why you skipped it.";

const CLOSED_IS_FINAL = "This job is closed, so its status can't change any more.";

/** A status code, compared after trimming and lowercasing (" Applied " = applied). Labels are not accepted. */
export function parseJobStatus(input: string): ParseResult<{ status: JobStatus }> {
  const code = input.trim().toLowerCase();
  const status = JOB_STATUSES.find((s) => s === code);
  return status ? { ok: true, status } : { ok: false, message: UNKNOWN_STATUS };
}

/**
 * The optional note on a status change: trimmed; absent, null or blank (no visible character)
 * means no note. Plain text (the résumé's rule), line breaks allowed, at most 500 characters
 * counted as a person counts them, after trimming.
 */
export function parseStatusNote(input: string | null | undefined): ParseResult<{ note: string | null }> {
  if (input === undefined || input === null) return { ok: true, note: null };
  if (!isPlainText(input)) {
    return { ok: false, message: "The note has characters that aren't text (control characters). Write it as plain text." };
  }
  const note = input.trim();
  if (!hasVisibleChar(note)) return { ok: true, note: null };
  const chars = countChars(note);
  if (chars > MAX_STATUS_NOTE_CHARS) {
    return {
      ok: false,
      message: `The note is ${formatNumber(chars)} characters; the limit is ${formatNumber(MAX_STATUS_NOTE_CHARS)}.`,
    };
  }
  return { ok: true, note };
}

const quotedList = (statuses: readonly JobStatus[]): string =>
  statuses.map((s) => `"${s}"`).join(", ").replace(/, ([^,]*)$/, " or $1");

/**
 * May a job in `from` move to `to` with this note? Checked in this order: same status, closed,
 * a move ALLOWED_MOVES doesn't list, then skip without a note. The move comes before the note so
 * "applied → skip" is told it can't skip at all, not that it needs a reason.
 */
export function checkStatusMove(from: JobStatus, to: JobStatus, note: string | null): ParseResult<object> {
  if (from === to) return { ok: false, message: `The job is already "${to}".` };
  if (ALLOWED_MOVES[from].length === 0) return { ok: false, message: CLOSED_IS_FINAL };
  if (!canMove(from, to)) {
    return {
      ok: false,
      message: `A job can't move from "${from}" to "${to}". From "${from}" it can move to ${quotedList(ALLOWED_MOVES[from])}.`,
    };
  }
  if (to === "skip" && note === null) return { ok: false, message: SKIP_NEEDS_NOTE };
  return { ok: true };
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
const LIMIT_MESSAGE = `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.`;
const OFFSET_MESSAGE = "offset must be a whole number, 0 or higher.";

/** list_jobs paging: limit 1–100 (default 50), offset from 0 (default 0); null counts as not given. */
export function parseListPage(input: {
  limit?: number | null | undefined;
  offset?: number | null | undefined;
}): ParseResult<{ limit: number; offset: number }> {
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return { ok: false, message: LIMIT_MESSAGE };
  if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, message: OFFSET_MESSAGE };
  return { ok: true, limit, offset };
}
