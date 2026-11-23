// Saving a job (PRD 01 §2 story 3, §4): idempotent by source_url, and the first status ('saved')
// is written to jobs.status and job_status_history in ONE transaction. Real Postgres.
import { beforeEach, describe, expect, it } from "vitest";
import { findJobBySourceUrl, saveJob, type NewJob } from "../../src/db/jobs-repo.js";
import { migrate } from "../../src/db/migrate.js";
import { INITIAL_JOB_STATUS } from "../../src/domain/job-status.js";
import { openExtraConnection, openTestDb, type TestDb } from "./db-helpers.js";

const LINKED: NewJob = {
  sourceUrl: "https://jobs.lever.co/northwindlabs/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5",
  sourceKind: "lever",
  title: "Data Engineer",
  company: "northwindlabs",
  location: "Austin, TX",
  payText: "140,000–170,000 USD per year",
  description: "Northwind Labs makes inventory software for bakeries.",
};

const PASTED: NewJob = {
  sourceUrl: null,
  sourceKind: "paste",
  title: null,
  company: null,
  location: null,
  payText: null,
  description: "A pasted job description.",
};

describe("jobs repository", () => {
  let db: TestDb;

  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    await migrate(opened.client);
    return opened.cleanup;
  });

  async function count(table: string): Promise<number> {
    const result = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0]?.n ?? -1;
  }

  async function history(jobId: number) {
    const result = await db.client.query<{ to_status: string; note: string | null }>(
      "SELECT to_status, note FROM job_status_history WHERE job_id = $1 ORDER BY created_at, id",
      [jobId],
    );
    return result.rows;
  }

  it("the first status is 'saved'", () => {
    expect(INITIAL_JOB_STATUS).toBe("saved");
  });

  it("saves every field, status 'saved', and one history row", async () => {
    const { job, created } = await saveJob(db.client, LINKED);
    expect(created).toBe(true);
    expect(job).toMatchObject({ ...LINKED, status: "saved" });
    expect(typeof job.id).toBe("number");
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(await history(job.id)).toEqual([{ to_status: "saved", note: null }]);
  });

  it("the same URL twice returns the existing job and adds nothing", async () => {
    const first = await saveJob(db.client, LINKED);
    const second = await saveJob(db.client, { ...LINKED, title: "A different title" });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.title).toBe("Data Engineer");
    expect(await count("jobs")).toBe(1);
    expect(await count("job_status_history")).toBe(1);
  });

  it("two pasted jobs (no URL) are two jobs", async () => {
    const a = await saveJob(db.client, PASTED);
    const b = await saveJob(db.client, PASTED);
    expect(a.job.id).not.toBe(b.job.id);
    expect(await count("jobs")).toBe(2);
    expect(await count("job_status_history")).toBe(2);
  });

  it("two saves of the same URL at the same moment make one job", async () => {
    const other = await openExtraConnection(db.schema);
    try {
      const [a, b] = await Promise.all([saveJob(db.client, LINKED), saveJob(other, LINKED)]);
      expect(a.job.id).toBe(b.job.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(await count("jobs")).toBe(1);
      expect(await count("job_status_history")).toBe(1);
    } finally {
      await other.end();
    }
  });

  it("writes the job and its history row together: if the history insert fails, no job is left", async () => {
    await db.client.query(`
      CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history refused'; END $$;
      CREATE TRIGGER refuse_history BEFORE INSERT ON job_status_history FOR EACH ROW EXECUTE FUNCTION refuse();
    `);
    await expect(saveJob(db.client, LINKED)).rejects.toThrow("history refused");
    expect(await count("jobs")).toBe(0);
  });

  it("the database refuses a source kind that is not in the lookup table", async () => {
    await expect(saveJob(db.client, { ...LINKED, sourceKind: "indeed" as NewJob["sourceKind"] })).rejects.toThrow(
      /foreign key/,
    );
  });

  it("findJobBySourceUrl finds a saved job, and nothing for an unknown URL", async () => {
    const { job } = await saveJob(db.client, LINKED);
    expect(await findJobBySourceUrl(db.client, LINKED.sourceUrl ?? "")).toEqual(job);
    expect(await findJobBySourceUrl(db.client, "https://jobs.lever.co/x/y")).toBeUndefined();
  });
});
