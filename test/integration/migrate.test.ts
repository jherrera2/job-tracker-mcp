import { copyFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { listTables, openExtraConnection, openTestDb, type TestDb } from "./db-helpers.js";

// The six PRD §4 tables...
const PRD_TABLES = [
  "criteria",
  "fit_checks",
  "job_status_history",
  "jobs",
  "master_resume_versions",
  "prompts",
];
// ...plus the lookup tables that replace hard-coded value lists.
const LOOKUP_TABLES = ["job_statuses", "recommendations", "source_kinds"];

describe("migrate (real migrations/ folder)", () => {
  let db: TestDb;

  // The function returned from beforeEach is Vitest's per-test teardown (like a using/Dispose
  // block). It is only registered if setup succeeded, and it closes over THIS test's handle,
  // so a failed setup (e.g. Postgres down) can never make teardown touch a previous test's
  // already-closed connection and bury the real error.
  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    return () => opened.cleanup();
  });

  it("on an empty database creates the PRD tables, the lookup tables and schema_migrations", async () => {
    expect(await listTables(db.client)).toEqual([]);

    const applied = await migrate(db.client);

    expect(applied).toContain("001_init.sql");
    expect(await listTables(db.client)).toEqual([...PRD_TABLES, ...LOOKUP_TABLES, "schema_migrations"].sort());
  });

  it("records each applied file in schema_migrations", async () => {
    await migrate(db.client);
    const rows = await db.client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(rows.rows.map((r) => r.filename)).toContain("001_init.sql");
  });

  it("003 adds the list_jobs page index and a latest-fit index that includes the id tie-break", async () => {
    await migrate(db.client);
    const rows = await db.client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname",
    );
    const defs = Object.fromEntries(rows.rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.jobs_updated_at_id_idx).toMatch(/ON \S*jobs USING btree \(updated_at DESC, id DESC\)/);
    expect(defs.fit_checks_job_latest_idx).toMatch(/ON \S*fit_checks USING btree \(job_id, created_at DESC, id DESC\)/);
    // Replaced by fit_checks_job_latest_idx, which covers the same lookups.
    expect(defs).not.toHaveProperty("fit_checks_job_id_created_at_idx");
  });

  it("is idempotent: a second run applies nothing and changes nothing", async () => {
    await migrate(db.client);
    const tablesBefore = await listTables(db.client);
    const recordedBefore = await db.client.query("SELECT filename, applied_at FROM schema_migrations ORDER BY filename");

    const appliedSecondTime = await migrate(db.client);

    expect(appliedSecondTime).toEqual([]);
    expect(await listTables(db.client)).toEqual(tablesBefore);
    const recordedAfter = await db.client.query("SELECT filename, applied_at FROM schema_migrations ORDER BY filename");
    expect(recordedAfter.rows).toEqual(recordedBefore.rows);
  });

  it("several migrations at the same moment take turns: all succeed and each file is applied once (step 9 review M1)", async () => {
    const others = await Promise.all([1, 2, 3].map(() => openExtraConnection(db.schema)));
    try {
      const results = await Promise.all([db.client, ...others].map((c) => migrate(c)));

      const applied = results.flat();
      expect(new Set(applied).size).toBe(applied.length); // no file applied twice
      expect(applied).toContain("001_init.sql");
      expect(await listTables(db.client)).toEqual([...PRD_TABLES, ...LOOKUP_TABLES, "schema_migrations"].sort());
    } finally {
      await Promise.all(others.map((c) => c.end()));
    }
  });

  describe("database constraints in 001_init.sql", () => {
    beforeEach(async () => {
      await migrate(db.client);
    });

    async function insertJob(sourceUrl: string | null, status = "saved"): Promise<void> {
      await db.client.query(
        `INSERT INTO jobs (source_url, source_kind, title, company, description, status)
         VALUES ($1, 'paste', 'Engineer', 'Acme', 'A job description.', $2)`,
        [sourceUrl, status],
      );
    }

    it("accepts every allowed job status", async () => {
      const statuses = ["saved", "go", "skip", "applied", "interviewing", "offer", "closed"];
      for (const [i, status] of statuses.entries()) {
        await insertJob(`https://example.com/job/${i}`, status);
      }
      const count = await db.client.query<{ n: string }>("SELECT count(*) AS n FROM jobs");
      expect(Number(count.rows[0]?.n)).toBe(statuses.length);
    });

    it("rejects a job status outside the allowed list", async () => {
      await expect(insertJob("https://example.com/job/1", "maybe")).rejects.toThrow(/foreign key/i);
    });

    it("rejects an unknown source_kind", async () => {
      await expect(
        db.client.query(`INSERT INTO jobs (source_kind, description) VALUES ('linkedin', 'A job description.')`),
      ).rejects.toThrow(/foreign key/i);
    });

    it("defaults a new job's status to saved", async () => {
      await db.client.query(
        `INSERT INTO jobs (source_kind, description) VALUES ('paste', 'A job description.')`,
      );
      const row = await db.client.query<{ status: string }>("SELECT status FROM jobs");
      expect(row.rows[0]?.status).toBe("saved");
    });

    it("rejects the same source_url twice", async () => {
      await insertJob("https://boards.greenhouse.io/acme/jobs/1");
      await expect(insertJob("https://boards.greenhouse.io/acme/jobs/1")).rejects.toThrow(/unique/i);
    });

    it("allows many pasted jobs with no source_url", async () => {
      await insertJob(null);
      await insertJob(null);
      const count = await db.client.query<{ n: string }>("SELECT count(*) AS n FROM jobs");
      expect(Number(count.rows[0]?.n)).toBe(2);
    });

    it("rejects a status-history row with an unknown to_status", async () => {
      await insertJob(null);
      await expect(
        db.client.query(`INSERT INTO job_status_history (job_id, to_status) SELECT id, 'maybe' FROM jobs`),
      ).rejects.toThrow(/foreign key/i);
    });

    it("has no from_status column: the previous status is the prior history row", async () => {
      const cols = await db.client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'job_status_history'
         ORDER BY ordinal_position`,
      );
      expect(cols.rows.map((c) => c.column_name)).toEqual(["id", "job_id", "to_status", "note", "created_at"]);
    });

    it("orders history deterministically by created_at, then id, even with equal timestamps", async () => {
      await insertJob(null);
      // Same timestamp on every row: id (always increasing) breaks the tie.
      for (const status of ["saved", "go", "applied"]) {
        await db.client.query(
          `INSERT INTO job_status_history (job_id, to_status, created_at)
           SELECT id, $1, '2026-11-16T12:00:00Z' FROM jobs`,
          [status],
        );
      }
      const rows = await db.client.query<{ to_status: string; previous: string | null }>(
        `SELECT to_status, LAG(to_status) OVER (ORDER BY created_at, id) AS previous
         FROM job_status_history ORDER BY created_at, id`,
      );
      expect(rows.rows).toEqual([
        { to_status: "saved", previous: null },
        { to_status: "go", previous: "saved" },
        { to_status: "applied", previous: "go" },
      ]);
    });

    it("rejects a status-history row or fit check for a job that does not exist", async () => {
      await expect(
        db.client.query(`INSERT INTO job_status_history (job_id, to_status) VALUES (999999, 'go')`),
      ).rejects.toThrow(/foreign key/i);
      await expect(
        db.client.query(
          `INSERT INTO fit_checks (job_id, prompt_version, model, result_json, jd_match_pct, recommendation, latency_ms)
           VALUES (999999, 1, 'm', '{}', 50, 'go', 10)`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("rejects a fit-check recommendation other than go / maybe / skip", async () => {
      await insertJob(null);
      await expect(
        db.client.query(
          `INSERT INTO fit_checks (job_id, prompt_version, model, result_json, jd_match_pct, recommendation, latency_ms)
           SELECT id, 1, 'm', '{}', 50, 'apply', 10 FROM jobs`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("rejects a second prompt with the same name and version", async () => {
      const insert = "INSERT INTO prompts (name, version, text) VALUES ('fit_check', 1, 'Prompt text.')";
      await db.client.query(insert);
      await expect(db.client.query(insert)).rejects.toThrow(/unique/i);
      // Same version number under a different name is fine.
      await db.client.query("INSERT INTO prompts (name, version, text) VALUES ('other', 1, 'Prompt text.')");
    });

    it("rejects two master résumé rows with the same version", async () => {
      const insert = "INSERT INTO master_resume_versions (version, text) VALUES (1, 'Résumé text.')";
      await db.client.query(insert);
      await expect(db.client.query(insert)).rejects.toThrow(/unique/i);
    });

    it("allows criteria positions 1 to 5 and rejects 0 and 6", async () => {
      const insert = (position: number) =>
        db.client.query("INSERT INTO criteria (position, label, detail) VALUES ($1, 'Pay', 'At least $140k')", [
          position,
        ]);
      for (const position of [1, 2, 3, 4, 5]) await insert(position);
      await expect(insert(0)).rejects.toThrow(/check constraint/i);
      await expect(insert(6)).rejects.toThrow(/check constraint/i);
    });

    it("keeps both fit-check scores between 0 and 100", async () => {
      await insertJob(null);
      const insertFit = (jdPct: number, criteriaPct: number | null) =>
        db.client.query(
          `INSERT INTO fit_checks (job_id, prompt_version, model, result_json, jd_match_pct, criteria_match_pct, recommendation, latency_ms)
           SELECT id, 1, 'm', '{}', $1, $2, 'go', 10 FROM jobs`,
          [jdPct, criteriaPct],
        );
      await insertFit(0, 100);
      await insertFit(100, null); // NULL criteria score = no criteria saved yet
      await expect(insertFit(100.5, 50)).rejects.toThrow(/check constraint/i);
      await expect(insertFit(-1, 50)).rejects.toThrow(/check constraint/i);
      await expect(insertFit(50, 101)).rejects.toThrow(/check constraint/i);
    });
  });
});

describe("002: fit checks written by the user's chat model", () => {
  let db: TestDb;

  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    await migrate(opened.client);
    return () => opened.cleanup();
  });

  async function insertJob(): Promise<string> {
    const row = await db.client.query<{ id: string }>(
      "INSERT INTO jobs (source_kind, description) VALUES ('paste', 'A job description.') RETURNING id",
    );
    return row.rows[0]?.id ?? "";
  }

  it("is applied after 001 (and before 003 and 004)", async () => {
    const rows = await db.client.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(rows.rows.map((r) => r.filename)).toEqual([
      "001_init.sql",
      "002_fit_checks_from_chat_model.sql",
      "003_list_and_latest_fit_indexes.sql",
      "004_employer_view.sql",
    ]);
  });

  it("lets model and latency_ms be NULL (the server no longer calls the model, so it can't know them)", async () => {
    const jobId = await insertJob();
    await db.client.query("INSERT INTO master_resume_versions (version, text) VALUES (1, 'Résumé.')");
    await db.client.query(
      `INSERT INTO fit_checks (job_id, prompt_version, master_resume_version, result_json, jd_match_pct, recommendation)
       VALUES ($1, 1, 1, '{}', 50, 'go')`,
      [jobId],
    );
    const row = await db.client.query("SELECT model, latency_ms FROM fit_checks");
    expect(row.rows).toEqual([{ model: null, latency_ms: null }]);
  });

  it("ties master_resume_version to a saved résumé version", async () => {
    const jobId = await insertJob();
    await expect(
      db.client.query(
        `INSERT INTO fit_checks (job_id, prompt_version, master_resume_version, result_json, jd_match_pct, recommendation)
         VALUES ($1, 1, 42, '{}', 50, 'go')`,
        [jobId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("adds quotes_dropped (never negative) and weak_go", async () => {
    const jobId = await insertJob();
    const insert = (dropped: number) =>
      db.client.query(
        `INSERT INTO fit_checks (job_id, prompt_version, result_json, jd_match_pct, recommendation, quotes_dropped, weak_go)
         VALUES ($1, 1, '{}', 50, 'go', $2, false)`,
        [jobId, dropped],
      );
    await insert(0);
    await expect(insert(-1)).rejects.toThrow(/check constraint/i);
  });

  it("still refuses a negative latency when one is given", async () => {
    const jobId = await insertJob();
    await expect(
      db.client.query(
        `INSERT INTO fit_checks (job_id, prompt_version, result_json, jd_match_pct, recommendation, latency_ms)
         VALUES ($1, 1, '{}', 50, 'go', -1)`,
        [jobId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("002 applied over a 001 database that already has a fit check", () => {
  let db: TestDb;
  let dir: string;

  beforeEach(() => {
    const created = mkdtempSync(join(tmpdir(), "migrations-"));
    dir = created;
    return () => rmSync(created, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    return () => opened.cleanup();
  });

  it("keeps the old row as it was, with NULL for what 001 never recorded", async () => {
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, "001_init.sql"), join(dir, "001_init.sql"));
    expect(await migrate(db.client, dir)).toEqual(["001_init.sql"]);
    await db.client.query("INSERT INTO jobs (source_kind, description) VALUES ('paste', 'A job description.')");
    await db.client.query(
      `INSERT INTO fit_checks (job_id, prompt_version, model, result_json, jd_match_pct, criteria_match_pct, recommendation, latency_ms, input_tokens)
       SELECT id, 1, 'old-model', '{"summary": "old"}', 62.5, NULL, 'maybe', 1234, 900 FROM jobs`,
    );

    expect(await migrate(db.client)).toEqual([
      "002_fit_checks_from_chat_model.sql",
      "003_list_and_latest_fit_indexes.sql",
      "004_employer_view.sql",
    ]);

    const rows = await db.client.query(
      `SELECT prompt_version, model, result_json, jd_match_pct, criteria_match_pct, recommendation, latency_ms, input_tokens,
              master_resume_version, quotes_dropped, weak_go
       FROM fit_checks`,
    );
    expect(rows.rows).toEqual([
      {
        prompt_version: 1,
        model: "old-model",
        result_json: { summary: "old" },
        jd_match_pct: "62.50",
        criteria_match_pct: null,
        recommendation: "maybe",
        latency_ms: 1234,
        input_tokens: 900,
        master_resume_version: null,
        quotes_dropped: null,
        weak_go: null,
      },
    ]);
  });
});

describe("004: employer view (step 11)", () => {
  let db: TestDb;
  let dir: string;

  beforeEach(() => {
    const created = mkdtempSync(join(tmpdir(), "migrations-"));
    dir = created;
    return () => rmSync(created, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    return () => opened.cleanup();
  });

  async function insertJob(): Promise<string> {
    const row = await db.client.query<{ id: string }>(
      "INSERT INTO jobs (source_kind, description) VALUES ('paste', 'A job description.') RETURNING id",
    );
    return row.rows[0]?.id ?? "";
  }

  it("adds strict_jd_match_pct numeric(5,2) and suggestions_dropped integer, both nullable", async () => {
    await migrate(db.client);
    const columns = await db.client.query<{ column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null; is_nullable: string }>(
      `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'fit_checks'
         AND column_name IN ('strict_jd_match_pct', 'suggestions_dropped') ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "strict_jd_match_pct", data_type: "numeric", numeric_precision: 5, numeric_scale: 2, is_nullable: "YES" },
      { column_name: "suggestions_dropped", data_type: "integer", numeric_precision: 32, numeric_scale: 0, is_nullable: "YES" },
    ]);
  });

  it("keeps the strict % between 0 and 100 and suggestions_dropped at 0 or more", async () => {
    await migrate(db.client);
    const jobId = await insertJob();
    const insert = (strict: number | null, dropped: number | null) =>
      db.client.query(
        `INSERT INTO fit_checks (job_id, prompt_version, result_json, jd_match_pct, recommendation, strict_jd_match_pct, suggestions_dropped)
         VALUES ($1, 1, '{}', 50, 'go', $2, $3)`,
        [jobId, strict, dropped],
      );
    await insert(0, 0);
    await insert(100, 3);
    await insert(null, null);
    await expect(insert(100.5, 0)).rejects.toThrow(/check constraint/i);
    await expect(insert(-1, 0)).rejects.toThrow(/check constraint/i);
    await expect(insert(50, -1)).rejects.toThrow(/check constraint/i);
  });

  it("applied over a 003 database with a fit check, keeps the row and leaves the new columns NULL", async () => {
    for (const file of ["001_init.sql", "002_fit_checks_from_chat_model.sql", "003_list_and_latest_fit_indexes.sql"]) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(dir, file));
    }
    await migrate(db.client, dir);
    const jobId = await insertJob();
    await db.client.query(
      `INSERT INTO fit_checks (job_id, prompt_version, result_json, jd_match_pct, recommendation, quotes_dropped, weak_go)
       VALUES ($1, 1, '{"summary": "old"}', 62.5, 'maybe', 0, false)`,
      [jobId],
    );

    expect(await migrate(db.client)).toEqual(["004_employer_view.sql"]);

    const rows = await db.client.query(
      "SELECT result_json, jd_match_pct, quotes_dropped, weak_go, strict_jd_match_pct, suggestions_dropped FROM fit_checks",
    );
    expect(rows.rows).toEqual([
      {
        result_json: { summary: "old" },
        jd_match_pct: "62.50",
        quotes_dropped: 0,
        weak_go: false,
        strict_jd_match_pct: null,
        suggestions_dropped: null,
      },
    ]);
  });
});

describe("migrate (temporary folder with a broken file)", () => {
  let db: TestDb;
  let dir: string;

  // Two setup hooks, each returning its own teardown (see the note in the first describe block):
  // the temp folder is removed even if opening the database fails.
  beforeEach(() => {
    const created = mkdtempSync(join(tmpdir(), "migrations-"));
    dir = created;
    return () => rmSync(created, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    return () => opened.cleanup();
  });

  it("applies files in numeric order end to end", async () => {
    // "10_" sorts before "9_" as plain text, so this fails if the runner doesn't compare numbers.
    // (The ordering rule itself is unit-tested in test/unit/migration-order.test.ts.)
    writeFileSync(join(dir, "10_add_column.sql"), "ALTER TABLE things ADD COLUMN size int;");
    writeFileSync(join(dir, "9_create.sql"), "CREATE TABLE things (id int);");
    writeFileSync(join(dir, "README.txt"), "not a migration");

    const applied = await migrate(db.client, dir);

    expect(applied).toEqual(["9_create.sql", "10_add_column.sql"]);
  });

  it("refuses a lone file without a number prefix and applies or records nothing", async () => {
    writeFileSync(join(dir, "add_index.sql"), "CREATE TABLE should_not_exist (id int);");

    await expect(migrate(db.client, dir)).rejects.toThrow(/add_index\.sql/);

    expect(await listTables(db.client)).toEqual(["schema_migrations"]);
    const recorded = await db.client.query("SELECT filename FROM schema_migrations");
    expect(recorded.rows).toEqual([]);
  });

  it("rolls back a file's changes when recording it fails", async () => {
    writeFileSync(join(dir, "001_good.sql"), "CREATE TABLE good_table (id int);");
    // The SQL itself succeeds, but it adds a rule that makes the runner's own
    // "INSERT INTO schema_migrations" for this file fail. Only a transaction around
    // BOTH the file and that insert can undo partial_table.
    writeFileSync(
      join(dir, "002_bad.sql"),
      `CREATE TABLE partial_table (id int);
       ALTER TABLE schema_migrations ADD CONSTRAINT refuse_002 CHECK (filename <> '002_bad.sql');`,
    );

    await expect(migrate(db.client, dir)).rejects.toThrow(/002_bad\.sql/);

    const tables = await listTables(db.client);
    expect(tables).toContain("good_table");
    expect(tables).not.toContain("partial_table");
    const recorded = await db.client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    expect(recorded.rows.map((r) => r.filename)).toEqual(["001_good.sql"]);
  });

  it("rolls back a file whose SQL fails part-way", async () => {
    writeFileSync(
      join(dir, "001_bad.sql"),
      "CREATE TABLE partial_table (id int);\nSELECT * FROM table_that_does_not_exist;",
    );

    await expect(migrate(db.client, dir)).rejects.toThrow(/001_bad\.sql/);

    expect(await listTables(db.client)).not.toContain("partial_table");
  });

  it("after a fix, a re-run applies only the previously failed file", async () => {
    writeFileSync(join(dir, "001_good.sql"), "CREATE TABLE good_table (id int);");
    writeFileSync(join(dir, "002_bad.sql"), "SELECT * FROM table_that_does_not_exist;");
    await expect(migrate(db.client, dir)).rejects.toThrow();

    writeFileSync(join(dir, "002_bad.sql"), "CREATE TABLE fixed_table (id int);");
    const applied = await migrate(db.client, dir);

    expect(applied).toEqual(["002_bad.sql"]);
    expect(await listTables(db.client)).toContain("fixed_table");
  });
});
