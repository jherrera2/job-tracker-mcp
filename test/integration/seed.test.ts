// `npm run db:seed` (PRD 01 §8 step 9): the fictional demo job seeker, stored through the real tools
// against a real Postgres. It fills an EMPTY database, does nothing the second time, finishes a
// demo that an earlier run left half-done, and never touches a database holding the user's own data.
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { replaceCriteria } from "../../src/db/criteria-repo.js";
import { saveMasterResume } from "../../src/db/master-resume-repo.js";
import { migrate } from "../../src/db/migrate.js";
import { DEMO_CRITERIA, DEMO_JOBS, DEMO_RESUME, type DemoJob } from "../../src/demo/demo-data.js";
import { seedDemo } from "../../src/demo/seed.js";
import { parseFitResult } from "../../src/domain/fit-result.js";
import { jdMatchPct } from "../../src/domain/fit-score.js";
import { createServer } from "../../src/server.js";
import { openExtraConnection, openTestDb, testDatabaseUrl, type TestDb } from "./db-helpers.js";

// What the demo is meant to show, per job (by title): its status after the seed and its fit.
const EXPECTED: Record<string, { status: string; recommendation: string; jd: number; criteria: number; weakGo: boolean }> = {
  "Senior Product Analyst": { status: "applied", recommendation: "go", jd: 90, criteria: 100, weakGo: false },
  "Analytics Engineer": { status: "saved", recommendation: "maybe", jd: 50, criteria: 70, weakGo: false },
  "Data Analyst, Player Insights": { status: "go", recommendation: "go", jd: 37.5, criteria: 80, weakGo: true },
  "Business Intelligence Lead": { status: "skip", recommendation: "skip", jd: 40, criteria: 30, weakGo: false },
  "Marketing Data Analyst": { status: "saved", recommendation: "maybe", jd: 80, criteria: 50, weakGo: false },
};
const MOVES = DEMO_JOBS.reduce((n, job) => n + job.moves.length, 0);
const TABLES = ["master_resume_versions", "criteria", "jobs", "job_status_history", "fit_checks", "prompts"] as const;

describe("db:seed (seedDemo)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb();
    await migrate(db.client);
    return () => db.cleanup();
  });

  const seed = (client: pg.Client = db.client) => seedDemo(client, { databaseUrl: testDatabaseUrl() });

  async function count(table: string): Promise<number> {
    const result = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0]?.n ?? -1;
  }

  /** Every row of every table the seed writes, so "nothing changed" can be checked exactly. */
  async function snapshot(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      out[table] = (await db.client.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return out;
  }

  async function jobsWithLatestFit() {
    const result = await db.client.query<{
      title: string;
      status: string;
      recommendation: string;
      jd_match_pct: string;
      criteria_match_pct: string;
      weak_go: boolean;
      quotes_dropped: number;
      model: string | null;
      result_json: { requirements: { status: string }[] };
    }>(
      `SELECT j.title, j.status, f.recommendation, f.jd_match_pct, f.criteria_match_pct, f.weak_go, f.quotes_dropped,
              f.model, f.result_json
       FROM jobs j JOIN fit_checks f ON f.job_id = j.id ORDER BY j.id`,
    );
    return result.rows;
  }

  it("fills an empty database: one résumé, five criteria, the jobs, one fit check each, and the status moves", async () => {
    const outcome = await seed();

    expect(outcome.status).toBe("seeded");
    expect(outcome.message).toMatch(/demo/i);
    expect(await count("master_resume_versions")).toBe(1);
    expect(await count("criteria")).toBe(DEMO_CRITERIA.length);
    expect(await count("jobs")).toBe(DEMO_JOBS.length);
    expect(await count("fit_checks")).toBe(DEMO_JOBS.length);
    expect(await count("job_status_history")).toBe(DEMO_JOBS.length + MOVES);
    expect(outcome.status === "seeded" && outcome.added).toEqual({
      resumes: 1,
      criteria: DEMO_CRITERIA.length,
      jobs: DEMO_JOBS.length,
      fit_checks: DEMO_JOBS.length,
      status_changes: MOVES,
    });
    const resume = await db.client.query<{ text: string }>("SELECT text FROM master_resume_versions");
    expect(resume.rows[0]?.text).toBe(DEMO_RESUME);
  });

  it("stores each fit through save_fit: scores computed by code, no quote dropped, the intended mix", async () => {
    await seed();

    const rows = await jobsWithLatestFit();
    expect(rows.map((r) => r.title).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const row of rows) {
      const want = EXPECTED[row.title];
      expect(want, row.title).toBeDefined();
      expect(
        {
          status: row.status,
          recommendation: row.recommendation,
          jd: Number(row.jd_match_pct),
          criteria: Number(row.criteria_match_pct),
          weakGo: row.weak_go,
        },
        row.title,
      ).toEqual(want);
      expect(row.quotes_dropped, row.title).toBe(0);
      expect(row.model, row.title).toMatch(/demo/i);
      // The stored statuses are the answer's own (nothing dropped), and the score is code's sum of them.
      const job = DEMO_JOBS.find((j) => j.title === row.title);
      const answer = parseFitResult(job?.fit);
      if (!answer.ok) throw new Error(answer.message);
      expect(row.result_json.requirements.map((r) => r.status)).toEqual(answer.result.requirements.map((r) => r.status));
      expect(Number(row.jd_match_pct)).toBe(jdMatchPct(answer.result.requirements.map((r) => r.status)));
    }
  });

  it("keeps the skip reason and the applied move on the history rows", async () => {
    await seed();

    const history = await db.client.query<{ title: string; to_status: string; note: string | null }>(
      `SELECT j.title, h.to_status, h.note FROM job_status_history h JOIN jobs j ON j.id = h.job_id ORDER BY h.created_at, h.id`,
    );
    const skip = history.rows.find((h) => h.to_status === "skip");
    expect(skip?.note?.trim()).toBeTruthy();
    expect(history.rows.some((h) => h.to_status === "applied")).toBe(true);
    for (const job of DEMO_JOBS) {
      expect(history.rows.filter((h) => h.title === job.title).map((h) => h.to_status)).toEqual([
        "saved",
        ...job.moves.map((m) => m.status),
      ]);
    }
  });

  it("run twice: the second run adds nothing and changes nothing (same rows, same ids)", async () => {
    await seed();
    const before = await snapshot();

    const outcome = await seed();

    expect(outcome.status).toBe("already_seeded");
    expect(outcome.message).toMatch(/already/i);
    expect(await snapshot()).toEqual(before);
  });

  it("finishes a demo an earlier run left half-done, without duplicating what is there", async () => {
    // As if a first run stopped after the résumé and the first job.
    await seed();
    const first = DEMO_JOBS[0];
    if (!first) throw new Error("no demo jobs");
    await db.client.query("DELETE FROM jobs WHERE title <> $1", [first.title]);
    await db.client.query("DELETE FROM criteria");
    const resumeId = (await snapshot()).master_resume_versions;

    const outcome = await seed();

    expect(outcome.status).toBe("seeded");
    expect(outcome.status === "seeded" && outcome.added).toEqual({
      resumes: 0,
      criteria: DEMO_CRITERIA.length,
      jobs: DEMO_JOBS.length - 1,
      fit_checks: DEMO_JOBS.length - 1,
      status_changes: MOVES - first.moves.length,
    });
    expect((await snapshot()).master_resume_versions).toEqual(resumeId);
    expect(await count("jobs")).toBe(DEMO_JOBS.length);
    expect(await count("fit_checks")).toBe(DEMO_JOBS.length);
    expect(await count("job_status_history")).toBe(DEMO_JOBS.length + MOVES);
  });

  it("leaves the user's own moves on demo jobs alone when run again", async () => {
    await seed();
    await db.client.query(
      `WITH j AS (SELECT id FROM jobs WHERE status = 'applied' LIMIT 1)
       , h AS (INSERT INTO job_status_history (job_id, to_status, note) SELECT id, 'interviewing', 'Phone screen booked.' FROM j)
       UPDATE jobs SET status = 'interviewing' WHERE id IN (SELECT id FROM j)`,
    );
    const before = await snapshot();

    const outcome = await seed();

    expect(outcome.status).toBe("already_seeded");
    expect(await snapshot()).toEqual(before);
  });

  describe("refuses a database that holds the user's own data, and writes nothing", () => {
    const cases: [string, (client: pg.Client) => Promise<unknown>, RegExp][] = [
      [
        "a résumé of their own",
        (c) => c.query("INSERT INTO master_resume_versions (version, text) VALUES (1, $1)", ["My own résumé. ".repeat(20)]),
        /résumé/,
      ],
      [
        "criteria of their own",
        (c) => c.query("INSERT INTO criteria (position, label, detail) VALUES (1, 'Pay floor', 'At least $250k.')"),
        /criteria/,
      ],
      [
        "a job of their own",
        (c) =>
          c.query(
            "WITH j AS (INSERT INTO jobs (source_kind, title, description) VALUES ('paste', 'My real job', $1) RETURNING id) " +
              "INSERT INTO job_status_history (job_id, to_status) SELECT id, 'saved' FROM j",
            ["A real posting. ".repeat(20)],
          ),
        /job/,
      ],
      [
        "an edited fit_check prompt",
        (c) => c.query("INSERT INTO prompts (name, version, text, is_default) VALUES ('fit_check', 2, 'My prompt.', false)"),
        /prompt/,
      ],
      [
        "a demo résumé they then replaced with their own",
        async (c) => {
          await c.query("INSERT INTO master_resume_versions (version, text) VALUES (1, $1)", [DEMO_RESUME]);
          await c.query("INSERT INTO master_resume_versions (version, text) VALUES (2, $1)", ["My own résumé. ".repeat(20)]);
        },
        /résumé/,
      ],
    ];

    for (const [name, arrange, mentions] of cases) {
      it(name, async () => {
        await arrange(db.client);
        const before = await snapshot();

        const outcome = await seed();

        expect(outcome.status).toBe("refused");
        expect(outcome.message).toMatch(/isn't the demo|not the demo/i);
        expect(outcome.message).toMatch(/added no demo data/);
        expect(outcome.message).not.toMatch(/changed nothing/);
        expect(outcome.message).toMatch(mentions);
        expect(await snapshot()).toEqual(before);
        await expectTransactionClosed(db.client);
      });
    }

    it("a job of their own added AFTER the demo: run again, it refuses and changes nothing", async () => {
      await seed();
      await db.client.query(
        "WITH j AS (INSERT INTO jobs (source_kind, title, description) VALUES ('paste', 'My real job', $1) RETURNING id) " +
          "INSERT INTO job_status_history (job_id, to_status) SELECT id, 'saved' FROM j",
        ["A real posting. ".repeat(20)],
      );
      const before = await snapshot();

      const outcome = await seed();

      expect(outcome.status).toBe("refused");
      expect(await snapshot()).toEqual(before);
    });
  });

  /** Pastes a job straight into the tables, as the live server's add_job would. */
  async function pasteJob(title: string | null, company: string | null, text: string, sourceUrl: string | null = null) {
    await db.client.query(
      `WITH j AS (INSERT INTO jobs (source_url, source_kind, title, company, description) VALUES ($1, $2, $3, $4, $5) RETURNING id)
       INSERT INTO job_status_history (job_id, to_status) SELECT id, 'saved' FROM j`,
      [sourceUrl, sourceUrl === null ? "paste" : "greenhouse", title, company, text],
    );
  }

  const statusOf = async (title: string) =>
    (await db.client.query<{ status: string }>("SELECT status FROM jobs WHERE title = $1", [title])).rows.map((r) => r.status);

  /** One demo job, which a test may change for a moment (it must put it back in a finally). */
  const demoJob = (i: number): DemoJob => {
    const job = DEMO_JOBS[i];
    if (!job) throw new Error(`no demo job ${i}`);
    return job;
  };

  describe("pinned by the step 9 tester and reviewer", () => {
    it("a half-done demo whose job the user moved off the plan (saved → skip) keeps the user's move", async () => {
      await seed();
      const first = demoJob(0); // planned: go, applied
      await db.client.query("DELETE FROM jobs WHERE title <> $1", [first.title]);
      await db.client.query(
        "DELETE FROM job_status_history h USING jobs j WHERE h.job_id = j.id AND j.title = $1 AND h.to_status <> 'saved'",
        [first.title],
      );
      await db.client.query(
        "INSERT INTO job_status_history (job_id, to_status, note) SELECT id, 'skip', 'Mine: not for me' FROM jobs WHERE title = $1",
        [first.title],
      );
      await db.client.query("UPDATE jobs SET status = 'skip' WHERE title = $1", [first.title]);

      const outcome = await seed();

      expect(outcome.status).toBe("seeded");
      expect(await statusOf(first.title)).toEqual(["skip"]);
    });

    it("a complete demo whose job the user moved (saved → go) is left as it is", async () => {
      await seed();
      await db.client.query("INSERT INTO job_status_history (job_id, to_status) SELECT id, 'go' FROM jobs WHERE title = 'Analytics Engineer'");
      await db.client.query("UPDATE jobs SET status = 'go' WHERE title = 'Analytics Engineer'");
      const before = await snapshot();

      expect((await seed()).status).toBe("already_seeded");
      expect(await snapshot()).toEqual(before);
    });

    it("a demo job with no history rows gets no moves (it never replays the last planned move)", async () => {
      await seed();
      await db.client.query(
        "DELETE FROM job_status_history h USING jobs j WHERE h.job_id = j.id AND j.title = 'Senior Product Analyst'",
      );
      const before = await snapshot();

      expect((await seed()).status).toBe("already_seeded");
      expect(await snapshot()).toEqual(before);
    });

    it("a demo posting pasted again by the user (complete demo): refused, unchanged", async () => {
      await seed();
      const job = demoJob(1);
      await pasteJob(job.title, job.company, job.text);
      const before = await snapshot();

      expect((await seed()).status).toBe("refused");
      expect(await snapshot()).toEqual(before);
    });

    it("a half-done demo where the user pasted a missing demo posting twice: refused, unchanged", async () => {
      await seed();
      const job = demoJob(2);
      await db.client.query("DELETE FROM jobs WHERE title = $1", [job.title]);
      await pasteJob(job.title, job.company, job.text);
      await pasteJob(job.title, job.company, job.text);
      const before = await snapshot();

      expect((await seed()).status).toBe("refused");
      expect(await snapshot()).toEqual(before);
    });

    it("a demo posting's exact text saved from a LINK is the user's job, not the demo's: refused", async () => {
      const job = demoJob(0);
      await pasteJob(job.title, job.company, job.text, "https://job-boards.greenhouse.io/someco/jobs/123");
      const before = await snapshot();

      const outcome = await seed();

      expect(outcome.status).toBe("refused");
      expect(outcome.message).toMatch(/job/);
      expect(await snapshot()).toEqual(before);
    });

    it("partly seeded plus one job of the user's own: refused, unchanged", async () => {
      await seed();
      await db.client.query("DELETE FROM jobs WHERE id > (SELECT min(id) + 1 FROM jobs)");
      await db.client.query("DELETE FROM criteria");
      await pasteJob("Mine", null, "Real posting. ".repeat(20));
      const before = await snapshot();

      expect((await seed()).status).toBe("refused");
      expect(await snapshot()).toEqual(before);
    });

    it("runs two and three leave every row byte-identical, timestamps included", async () => {
      await seed();
      const dump = async () => {
        const out: string[] = [];
        for (const table of TABLES) out.push(JSON.stringify((await db.client.query(`SELECT t::text FROM ${table} t ORDER BY id`)).rows));
        return out.join("\n");
      };
      const first = await dump();

      await seed();
      await seed();

      expect(await dump()).toBe(first);
    });
  });

  describe("all or nothing (review M2, tester M1)", () => {
    it("a demo quote that isn't in the résumé stops the seed BEFORE anything is written; fixed, a rerun seeds everything", async () => {
      const requirement = demoJob(0).fit.requirements.find((r) => r.evidence_quote !== undefined);
      if (!requirement) throw new Error("no quoted requirement");
      const original = requirement.evidence_quote;
      requirement.evidence_quote = "Led a team of 40 engineers on a moon base";
      try {
        await expect(seed()).rejects.toThrow(/quote/);
        for (const table of TABLES) expect(await count(table), table).toBe(0);
      } finally {
        requirement.evidence_quote = original;
      }

      const outcome = await seed();

      expect(outcome.status).toBe("seeded");
      expect(await count("fit_checks")).toBe(DEMO_JOBS.length);
      const dropped = await db.client.query<{ n: number }>("SELECT coalesce(sum(quotes_dropped), 0)::int AS n FROM fit_checks");
      expect(dropped.rows[0]?.n).toBe(0);
    });

    it("a tool refusing part-way rolls the whole seed back: nothing is left half-done", async () => {
      const job = demoJob(DEMO_JOBS.length - 1);
      const original = job.moves;
      job.moves = [{ status: "closed" }]; // saved → closed is not an allowed move
      try {
        await expect(seed()).rejects.toThrow(/set_status/);
        for (const table of TABLES) expect(await count(table), table).toBe(0);
      } finally {
        job.moves = original;
      }
      expect((await seed()).status).toBe("seeded");
      expect(await count("job_status_history")).toBe(DEMO_JOBS.length + MOVES);
    });

    it("a save from the live server DURING the seed waits for it, then lands on top: nothing of the user's is replaced", async () => {
      const user = await openExtraConnection(db.schema);
      const userResume = "My own résumé, saved from my chat. ".repeat(10);
      const userCriteria = [{ label: "Pay floor", detail: "At least $250k." }];
      let userSave: Promise<unknown> = Promise.resolve();
      try {
        const pid = (await user.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        const outcome = await seedDemo(db.client, {
          databaseUrl: testDatabaseUrl(),
          // After the seed has looked at the tables and before it writes: the user saves.
          afterSurvey: async () => {
            userSave = (async () => {
              await saveMasterResume(user, userResume);
              await replaceCriteria(user, userCriteria);
            })();
            await waitUntilWaitingOnALock(pid);
          },
        });
        await userSave;

        expect(outcome.status).toBe("seeded");
        const latest = await db.client.query<{ text: string }>("SELECT text FROM master_resume_versions ORDER BY version DESC LIMIT 1");
        expect(latest.rows[0]?.text).toBe(userResume);
        const criteria = await db.client.query("SELECT label, detail FROM criteria ORDER BY position");
        expect(criteria.rows).toEqual(userCriteria);
      } finally {
        await userSave.catch(() => undefined);
        await user.end();
      }
    });
  });

  /**
   * The seed's connection is outside any transaction, and none of the six tables is still locked:
   * another connection can write to each at once. Fails if a refusal forgets its ROLLBACK.
   */
  async function expectTransactionClosed(seedConnection: pg.Client): Promise<void> {
    const pid = (await seedConnection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    const other = await openExtraConnection(db.schema);
    try {
      const state = await other.query<{ state: string }>("SELECT state FROM pg_stat_activity WHERE pid = $1", [pid]);
      expect(state.rows[0]?.state).toBe("idle");
      await other.query("SET lock_timeout = '500ms'");
      for (const table of TABLES) await other.query(`DELETE FROM ${table} WHERE false`);
    } finally {
      await other.end();
    }
  }

  /** The real MCP server on its own pool, as a running chat app has it. */
  async function liveServer() {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 6 });
    const server = createServer({ db: pool, databaseUrl: testDatabaseUrl() });
    const client = new Client({ name: "live-chat", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(`${name}: ${text}`);
      return (result.structuredContent ?? {}) as Record<string, unknown>;
    };
    return {
      call,
      close: async () => {
        await client.close();
        await server.close();
        await pool.end();
      },
    };
  }

  /** Resolves with true if `promise` settles within `ms`, false if it is still waiting. */
  const settlesWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  /** A seed that has work to do on a demo database: the last demo job is removed first. */
  async function demoMissingLastJob(): Promise<void> {
    await seed();
    await db.client.query("DELETE FROM jobs WHERE id = (SELECT max(id) FROM jobs)");
  }

  describe("its table locks (step 9 round 2)", () => {
    // One test per table: while the seed holds its locks, a write to that table must wait. Each
    // statement touches its table only (no rows, so no foreign-key checks reach another table),
    // so taking ANY one table out of the lock makes its test fail.
    for (const table of TABLES) {
      it(`a write to ${table} waits for the seed`, async () => {
        const other = await openExtraConnection(db.schema);
        let error: unknown;
        try {
          await seedDemo(db.client, {
            databaseUrl: testDatabaseUrl(),
            afterSurvey: async () => {
              await other.query("SET lock_timeout = '300ms'");
              error = await other.query(`DELETE FROM ${table} WHERE false`).then(
                () => undefined,
                (err: unknown) => err,
              );
            },
          });
        } finally {
          await other.end();
        }
        expect(String(error)).toMatch(/lock timeout/);
      });
    }

    it("reads are not blocked: list_jobs, get_job, get_master_resume and get_criteria answer while the seed holds its locks", async () => {
      await demoMissingLastJob();
      const jobId = (await db.client.query<{ id: number }>("SELECT min(id)::int AS id FROM jobs")).rows[0]?.id;
      const live = await liveServer();
      const answered: Record<string, boolean> = {};
      try {
        await seedDemo(db.client, {
          databaseUrl: testDatabaseUrl(),
          afterSurvey: async () => {
            for (const [name, args] of [
              ["list_jobs", {}],
              ["get_job", { id: jobId }],
              ["get_master_resume", {}],
              ["get_criteria", {}],
            ] as const) {
              answered[name] = await settlesWithin(live.call(name, args), 2_000);
            }
          },
        });
      } finally {
        await live.close();
      }
      expect(answered).toEqual({ list_jobs: true, get_job: true, get_master_resume: true, get_criteria: true });
    });

    it("live add_job, set_status and update_prompt racing the seed land after it and stay current", async () => {
      await seed();
      const analyticsId = (await db.client.query<{ id: number }>("SELECT id::int AS id FROM jobs WHERE title = 'Analytics Engineer'")).rows[0]?.id;
      await db.client.query("DELETE FROM jobs WHERE title = 'Marketing Data Analyst'");
      const live = await liveServer();
      let pending: Promise<unknown> = Promise.resolve();
      try {
        const outcome = await seedDemo(db.client, {
          databaseUrl: testDatabaseUrl(),
          afterSurvey: async () => {
            pending = Promise.all([
              live.call("add_job", { text: "My real posting. ".repeat(20), title: "Mine", company: "RealCo" }),
              live.call("set_status", { id: analyticsId, status: "go" }),
              live.call("update_prompt", { name: "fit_check", text: "My own prompt text. ".repeat(10) }),
            ]);
            // Give them time to reach the database; they must still be waiting.
            expect(await settlesWithin(pending, 400)).toBe(false);
          },
        });
        await pending;

        expect(outcome.status).toBe("seeded");
        expect((await db.client.query("SELECT status FROM jobs WHERE id = $1", [analyticsId])).rows[0]).toEqual({ status: "go" });
        expect((await db.client.query("SELECT is_default FROM prompts ORDER BY version DESC LIMIT 1")).rows[0]).toEqual({
          is_default: false,
        });
        const order = await db.client.query<{ later: boolean }>(
          "SELECT (SELECT id FROM jobs WHERE title = 'Mine') > (SELECT id FROM jobs WHERE title = 'Marketing Data Analyst') AS later",
        );
        expect(order.rows[0]?.later).toBe(true);
      } finally {
        await pending.catch(() => undefined);
        await live.close();
      }
    });

    it("a live save_fit racing the seed lands after it (no deadlock)", async () => {
      await demoMissingLastJob();
      const jobId = (await db.client.query<{ id: number }>("SELECT min(id)::int AS id FROM jobs")).rows[0]?.id;
      const live = await liveServer();
      let pending: Promise<unknown> = Promise.resolve();
      try {
        const inputs = await live.call("get_fit_inputs", { job_id: jobId });
        const outcome = await seedDemo(db.client, {
          databaseUrl: testDatabaseUrl(),
          afterSurvey: async () => {
            pending = live.call("save_fit", { job_id: jobId, ref: inputs.ref, result: DEMO_JOBS[0]?.fit, model: "user's chat" });
            expect(await settlesWithin(pending, 400)).toBe(false);
          },
        });
        await pending;

        expect(outcome.status).toBe("seeded");
        expect(await count("fit_checks")).toBe(DEMO_JOBS.length + 1);
        const latest = await db.client.query("SELECT model FROM fit_checks WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [jobId]);
        expect(latest.rows[0]).toEqual({ model: "user's chat" });
      } finally {
        await pending.catch(() => undefined);
        await live.close();
      }
    });

    // save_fit's INSERT takes fit_checks first, then its foreign-key checks lock the job row AND
    // the résumé version. One test per parent, so locking EITHER parent before fit_checks fails.
    const fkParents = [
      ["the job row (jobs)", "SELECT 1 FROM jobs WHERE id = (SELECT min(id) FROM jobs) FOR KEY SHARE"],
      ["the résumé version (master_resume_versions)", "SELECT 1 FROM master_resume_versions WHERE version = 1 FOR KEY SHARE"],
    ] as const;
    for (const [parent, fkCheckSql] of fkParents) {
      it(`a save_fit that locked fit_checks just before the seed, then checks ${parent}: both finish, no deadlock`, async () => {
        await demoMissingLastJob();
        const user = await openExtraConnection(db.schema);
        const seeder = await openExtraConnection(db.schema);
        const seederPid = (await seeder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        try {
          // Hold what the INSERT takes first and let the seed start.
          await user.query("BEGIN");
          await user.query("LOCK TABLE fit_checks IN ROW EXCLUSIVE MODE");
          const seeding = seedDemo(seeder, { databaseUrl: testDatabaseUrl() }).then(
            (o) => o.status,
            (err: unknown) => `failed: ${String(err)}`,
          );
          await waitUntilWaitingOnALock(seederPid);
          // Now the foreign-key check: it must not wait on the seed while the seed waits on it.
          const fkCheck = await user.query(fkCheckSql).then(
            () => "ok",
            (err: unknown) => `failed: ${String(err)}`,
          );
          await user.query("ROLLBACK");

          expect(fkCheck).toBe("ok");
          expect(await seeding).toBe("seeded");
        } finally {
          await user.end();
          await seeder.end();
        }
      });
    }

    // add_job (saveJob) and set_status (moveJobStatus) take jobs first, then write
    // job_status_history in the same transaction; locking history before jobs would deadlock them.
    for (const shape of ["set_status", "add_job"] as const) {
      it(`a ${shape} holding jobs when the seed starts, then writing the history: both finish, no deadlock`, async () => {
        await demoMissingLastJob();
        const demoJobId = (await db.client.query<{ id: number }>("SELECT min(id)::int AS id FROM jobs")).rows[0]?.id;
        const user = await openExtraConnection(db.schema);
        const seeder = await openExtraConnection(db.schema);
        const seederPid = (await seeder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        try {
          await user.query("BEGIN");
          let jobId = demoJobId;
          if (shape === "set_status") {
            await user.query("SELECT 1 FROM jobs WHERE id = $1 FOR NO KEY UPDATE", [demoJobId]);
          } else {
            const inserted = await user.query<{ id: number }>(
              "INSERT INTO jobs (source_kind, title, description) VALUES ('paste', 'Mine', $1) RETURNING id::int AS id",
              ["My real posting. ".repeat(20)],
            );
            jobId = inserted.rows[0]?.id;
          }
          const seeding = seedDemo(seeder, { databaseUrl: testDatabaseUrl() }).then(
            (o) => o.status,
            (err: unknown) => `failed: ${String(err)}`,
          );
          await waitUntilWaitingOnALock(seederPid);
          const historyWrite = await user.query("INSERT INTO job_status_history (job_id, to_status) VALUES ($1, 'saved')", [jobId]).then(
            () => "ok",
            (err: unknown) => `failed: ${String(err)}`,
          );
          await user.query(historyWrite === "ok" ? "COMMIT" : "ROLLBACK");

          expect(historyWrite).toBe("ok");
          // After set_status the database is still all demo, so the seed completes it; after the
          // user's own job is committed, the seed sees it and refuses.
          expect(await seeding).toBe(shape === "set_status" ? "seeded" : "refused");
        } finally {
          await user.end();
          await seeder.end();
        }
      });
    }
  });

  /** Polls until the backend `pid` is blocked on a lock (or 5 s pass, which fails the test). */
  async function waitUntilWaitingOnALock(pid: number | undefined): Promise<void> {
    const other = await openExtraConnection(db.schema);
    try {
      for (let i = 0; i < 100; i++) {
        const row = await other.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
        if (row.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("The user's save never waited on the seed's lock.");
    } finally {
      await other.end();
    }
  }

  it("five seeds at the same moment add the demo once", async () => {
    const extra = await Promise.all([1, 2, 3, 4].map(() => openExtraConnection(db.schema)));
    try {
      const outcomes = await Promise.all([db.client, ...extra].map((c) => seed(c)));

      expect(outcomes.map((o) => o.status).sort()).toEqual([
        "already_seeded",
        "already_seeded",
        "already_seeded",
        "already_seeded",
        "seeded",
      ]);
      expect([
        await count("master_resume_versions"),
        await count("jobs"),
        await count("fit_checks"),
        await count("prompts"),
      ]).toEqual([1, DEMO_JOBS.length, DEMO_JOBS.length, 1]);
    } finally {
      await Promise.all(extra.map((c) => c.end()));
    }
  });
});

describe("npm run db:seed (the real program)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb();
    return () => db.cleanup();
  });

  /** Runs src/demo/seed-cli.ts with DATABASE_URL pointed at this test's own schema. */
  function runSeedCli() {
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${db.schema}`);
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/demo/seed-cli.ts"], {
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: url.toString() },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it("migrates and seeds an empty database, then says it is already seeded (exit 0 both times)", async () => {
    const first = runSeedCli();
    expect(first.output).toMatch(/Seeded the demo/);
    expect(first.exitCode).toBe(0);
    const jobs = await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs");
    expect(jobs.rows[0]?.n).toBe(DEMO_JOBS.length);

    const second = runSeedCli();
    expect(second.output).toMatch(/already/i);
    expect(second.exitCode).toBe(0);
  });

  /** Same as runSeedCli, but without blocking, so several can run at once. */
  function runSeedCliAsync(): Promise<{ exitCode: number | null; output: string }> {
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${db.schema}`);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/demo/seed-cli.ts"], {
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: url.toString() },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("close", (exitCode) => resolve({ exitCode, output }));
    });
  }

  it("four seeds at once on a brand-new database: all exit 0, and the demo is there once (review M1)", async () => {
    const runs = await Promise.all([1, 2, 3, 4].map(() => runSeedCliAsync()));

    for (const run of runs) expect(run.exitCode, run.output).toBe(0);
    expect(runs.filter((r) => /Seeded the demo/.test(r.output))).toHaveLength(1);
    const jobs = await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs");
    expect(jobs.rows[0]?.n).toBe(DEMO_JOBS.length);
  });

  it("refuses a database with the user's own data: exit 1, a clear sentence, nothing written", async () => {
    await migrate(db.client);
    await db.client.query("INSERT INTO master_resume_versions (version, text) VALUES (1, $1)", ["My own résumé. ".repeat(20)]);

    const run = runSeedCli();

    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/isn't the demo|not the demo/i);
    expect(run.output).toMatch(/added no demo data/);
    const jobs = await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs");
    expect(jobs.rows[0]?.n).toBe(0);
  });
});
