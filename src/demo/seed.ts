// `npm run db:seed` (PRD 01 §8 step 9): puts the fictional demo job seeker (src/demo/demo-data.ts)
// into the database, so anyone can try the tools in minutes.
//
// Every write goes through the REAL MCP tools, called in-process through an in-memory MCP client:
// set_master_resume, set_criteria, add_job (pasted text, no network), get_fit_inputs + save_fit,
// set_status. So the demo passes exactly the checks a chat's calls pass: the shape check, the
// word-for-word quote check, the score math and ALLOWED_MOVES (ADR-001: code owns the trust).
//
// Safe to run again, and never touches the user's own data:
// 0. Before touching the database, every demo fit is checked against the demo résumé (shape and
//    quotes), so a broken demo stops here.
// 1. The whole seed is ONE transaction. It starts by locking the six tables it reads and writes
//    (EXCLUSIVE: others can still read, but their writes wait), then looks at what is there. So
//    what it saw can't change before it writes: a save from the live MCP server waits, and lands
//    after the seed, on top of the demo (step 9 review M2). Two seeds at once take turns the same way.
// 2. If anything there is NOT the demo's (a résumé, criteria or job of the user's own, or an
//    edited prompt), it adds no demo data at all.
// 3. Otherwise it adds only what is missing: an empty database gets the whole demo, a complete
//    demo gets nothing ("already seeded", same rows and ids), and a demo that is missing parts
//    (say the user deleted a job) is completed. It never deletes or overwrites anything.
// 4. Any failure part-way rolls everything back, so a run never leaves half a demo behind.
//    The tools' own transactions nest inside it as savepoints (OpenTransaction, src/db/database.ts).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type pg from "pg";
import { OpenTransaction, type Queryable } from "../db/database.js";
import { parseFitResult } from "../domain/fit-result.js";
import { checkEvidence } from "../domain/quote-check.js";
import { createServer } from "../server.js";
import { DEMO_CRITERIA, DEMO_JOBS, DEMO_MODEL, DEMO_RESUME, type DemoJob } from "./demo-data.js";

export interface SeedCounts {
  resumes: number;
  criteria: number;
  jobs: number;
  fit_checks: number;
  status_changes: number;
}

export type SeedOutcome =
  | { status: "seeded"; added: SeedCounts; message: string }
  | { status: "already_seeded"; message: string }
  | { status: "refused"; found: string[]; message: string };

// Every table the seed reads or writes. EXCLUSIVE blocks other writers (and another seed's lock)
// until this transaction ends, but still lets plain reads through (ACCESS SHARE).
//
// LOCK ORDER RULE: lock in the same order the live tools take their locks, or a live write and the
// seed can each hold what the other waits for ("deadlock detected", tester round 2). The live order:
// - save_fit: one INSERT INTO fit_checks takes fit_checks first, THEN its foreign-key checks lock
//   the job row (jobs) and the résumé version (master_resume_versions). So fit_checks comes before both.
// - add_job (saveJob) and set_status (moveJobStatus): jobs first (INSERT / SELECT … FOR NO KEY
//   UPDATE), THEN job_status_history in the same transaction. So jobs comes before job_status_history.
// - set_master_resume, set_criteria, update_prompt / reset_prompt / get_prompt's first-use insert:
//   one table each (master_resume_versions, criteria, prompts), so they can go anywhere.
// A child table is locked before the parents its inserts check; a table a transaction writes first
// comes before the ones it writes after. LOCK TABLE takes the locks in the order listed.
const SEED_TABLES = ["fit_checks", "jobs", "job_status_history", "master_resume_versions", "criteria", "prompts"];

const ALREADY_SEEDED = "The demo data is already in place; nothing was added.";

const refusedMessage = (found: readonly string[]) =>
  `This database already has data that isn't the demo's (${found.join(", ")}). ` +
  "The seed only fills an empty database, or completes its own demo, so it added no demo data. " +
  "To try the demo, point DATABASE_URL at a new, empty database.";

const jobKey = (title: string | null, company: string | null, text: string) => JSON.stringify([title, company, text]);

/** What is already in the database, and whether all of it is the demo's. */
interface Survey {
  found: string[];
  hasResume: boolean;
  hasCriteria: boolean;
  /** Demo job (by index in DEMO_JOBS) → its saved id. */
  jobIds: Map<number, number>;
}

async function survey(db: Queryable): Promise<Survey> {
  const found: string[] = [];

  const resumes = await db.query<{ text: string }>("SELECT text FROM master_resume_versions");
  if (resumes.rows.some((r) => r.text !== DEMO_RESUME)) found.push("a master résumé of your own");

  const criteria = await db.query<{ label: string; detail: string }>("SELECT label, detail FROM criteria ORDER BY position");
  const demoCriteria =
    criteria.rows.length === DEMO_CRITERIA.length &&
    criteria.rows.every((c, i) => c.label === DEMO_CRITERIA[i]?.label && c.detail === DEMO_CRITERIA[i]?.detail);
  if (criteria.rows.length > 0 && !demoCriteria) found.push("criteria of your own");

  const demoIndex = new Map(DEMO_JOBS.map((job, i) => [jobKey(job.title, job.company, job.text), i]));
  const jobs = await db.query<{ id: string; source_url: string | null; title: string | null; company: string | null; description: string }>(
    "SELECT id, source_url, title, company, description FROM jobs ORDER BY id",
  );
  const jobIds = new Map<number, number>();
  let ownJobs = false;
  for (const job of jobs.rows) {
    const index = job.source_url === null ? demoIndex.get(jobKey(job.title, job.company, job.description)) : undefined;
    // A demo posting saved twice was pasted again by someone, so it counts as theirs.
    if (index === undefined || jobIds.has(index)) ownJobs = true;
    else jobIds.set(index, Number(job.id));
  }
  if (ownJobs) found.push("jobs of your own");

  const edits = await db.query("SELECT 1 FROM prompts WHERE NOT is_default LIMIT 1");
  if (edits.rows.length > 0) found.push("an edited prompt");

  return { found, hasResume: resumes.rows.length > 0, hasCriteria: criteria.rows.length > 0, jobIds };
}

export interface SeedOptions {
  /** Only names host:port in error messages. */
  databaseUrl: string;
  /** Test seam: runs after the tables are locked and surveyed, before anything is written. */
  afterSurvey?: () => Promise<void>;
}

/**
 * Seeds the demo through the MCP tools, in one transaction. `db` must be ONE connection (a
 * pg.Client), not a pool: the transaction and its locks belong to that connection.
 */
export async function seedDemo(db: pg.ClientBase, options: SeedOptions): Promise<SeedOutcome> {
  checkDemoFits();
  await db.query("BEGIN");
  try {
    await db.query(`LOCK TABLE ${SEED_TABLES.join(", ")} IN EXCLUSIVE MODE`);
    const found = await survey(db);
    if (found.found.length > 0) {
      await db.query("ROLLBACK");
      return { status: "refused", found: found.found, message: refusedMessage(found.found) };
    }
    await options.afterSurvey?.();
    const outcome = await fill(new OpenTransaction(db), options.databaseUrl, found);
    await db.query("COMMIT");
    return outcome;
  } catch (err) {
    // A dead connection can't roll back, and has already dropped everything; report the real error.
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/**
 * The demo fits, checked as save_fit would check them, before the database is touched: a broken
 * demo stops the seed with nothing written (step 9 tester M1). save_fit checks them again for real.
 */
function checkDemoFits(): void {
  for (const job of DEMO_JOBS) {
    const parsed = parseFitResult(job.fit);
    if (!parsed.ok) throw new Error(`The demo fit for "${job.title}" is malformed: ${parsed.message}`);
    const { dropped } = checkEvidence(parsed.result.requirements, DEMO_RESUME);
    const first = dropped[0];
    if (first) {
      throw new Error(`The demo fit for "${job.title}" has an evidence quote that isn't in the demo résumé: "${first.evidence_quote}".`);
    }
  }
}

async function fill(db: OpenTransaction, databaseUrl: string, found: Survey): Promise<SeedOutcome> {
  const server = createServer({ db, databaseUrl });
  const client = new Client({ name: "db-seed", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  /** Calls a tool; a refusal means the demo data breaks a rule, which is a bug in this repo. */
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
      throw new Error(`The demo data was refused by ${name}: ${text}`);
    }
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }

  const added: SeedCounts = { resumes: 0, criteria: 0, jobs: 0, fit_checks: 0, status_changes: 0 };
  try {
    if (!found.hasResume) {
      await call("set_master_resume", { text: DEMO_RESUME });
      added.resumes = 1;
    }
    if (!found.hasCriteria) {
      await call("set_criteria", { criteria: DEMO_CRITERIA });
      added.criteria = DEMO_CRITERIA.length;
    }
    for (const [index, job] of DEMO_JOBS.entries()) {
      let jobId = found.jobIds.get(index);
      if (jobId === undefined) {
        const saved = await call("add_job", { text: job.text, title: job.title, company: job.company });
        jobId = (saved.job as { id: number }).id;
        added.jobs++;
      }
      added.fit_checks += await ensureFit(db, call, jobId, job);
      added.status_changes += await ensureMoves(db, call, jobId, job);
    }
  } finally {
    await client.close();
    await server.close();
  }

  const total = added.resumes + added.criteria + added.jobs + added.fit_checks + added.status_changes;
  if (total === 0) return { status: "already_seeded", message: ALREADY_SEEDED };
  return { status: "seeded", added, message: seededMessage(added) };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Writes the job's fit check (get_fit_inputs, then save_fit) unless it has one. Returns how many were added. */
async function ensureFit(db: Queryable, call: Call, jobId: number, job: DemoJob): Promise<number> {
  const existing = await db.query("SELECT 1 FROM fit_checks WHERE job_id = $1 LIMIT 1", [jobId]);
  if (existing.rows.length > 0) return 0;
  const inputs = await call("get_fit_inputs", { job_id: jobId });
  const saved = await call("save_fit", { job_id: jobId, ref: inputs.ref, result: job.fit, model: DEMO_MODEL });
  // Already checked before the seed began (checkDemoFits); kept as a backstop. Throwing here rolls
  // the whole seed back, this fit included.
  if (saved.quotes_dropped !== 0) {
    throw new Error(`The demo fit for "${job.title}" has an evidence quote that isn't in the demo résumé.`);
  }
  return 1;
}

/**
 * Makes the job's planned status moves with set_status, continuing from where its history stands
 * when that history is the start of the plan. A job someone moved elsewhere is left alone.
 * Returns how many moves were made.
 */
async function ensureMoves(db: Queryable, call: Call, jobId: number, job: DemoJob): Promise<number> {
  const history = await db.query<{ to_status: string }>(
    "SELECT to_status FROM job_status_history WHERE job_id = $1 ORDER BY created_at, id",
    [jobId],
  );
  const done = history.rows.map((h) => h.to_status);
  // No history at all can't come from the tools; without this, slice(-1) below would replay the last move.
  if (done[0] !== "saved") return 0;
  const planned = ["saved", ...job.moves.map((m) => m.status)];
  const onPlan = done.length <= planned.length && done.every((status, i) => status === planned[i]);
  if (!onPlan) return 0;
  let made = 0;
  for (const move of job.moves.slice(done.length - 1)) {
    await call("set_status", { id: jobId, status: move.status, note: move.note ?? null });
    made++;
  }
  return made;
}

function seededMessage(added: SeedCounts): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(added.resumes, "master résumé", "master résumés");
  add(added.criteria, "criterion", "criteria");
  add(added.jobs, "job", "jobs");
  add(added.fit_checks, "fit check", "fit checks");
  add(added.status_changes, "status change", "status changes");
  return (
    `Seeded the demo (Riley Example, a fictional job seeker): ${parts.join(", ")}. ` +
    "In your chat, ask to list the jobs (list_jobs) or open one (get_job)."
  );
}
