// Add a job from a link or pasted text (PRD 01 §2 story 3), end to end against a real Postgres,
// with the ATS APIs replaced by recorded fixtures (no live network). The add_job MCP tool and the
// fit check are wired in later steps (6–7); this tests the source layer + save underneath them.
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { addJobFromText, addJobFromUrl } from "../../src/sources/add-job.js";
import { CANT_READ_SITE } from "../../src/sources/job-url.js";
import { SOURCE_MESSAGES } from "../../src/sources/safe-fetch.js";
import {
  ASHBY_JOB_URL,
  GREENHOUSE_API_URL,
  GREENHOUSE_JOB_URL,
  LEVER_JOB_URL,
  fakeAtsFetch,
  fakeFetch,
} from "../support/fake-fetch.js";
import { openTestDb, type TestDb } from "./db-helpers.js";

const JD = `Staff Engineer at a fictional company. ${"We build accessible software for libraries. ".repeat(6)}`;

describe("adding a job", () => {
  let db: TestDb;

  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    await migrate(opened.client);
    return opened.cleanup;
  });

  async function jobCount(): Promise<number> {
    const result = await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs");
    return result.rows[0]?.n ?? -1;
  }

  describe("from a link", () => {
    it.each([
      [GREENHOUSE_JOB_URL, "greenhouse", "Senior Software Engineer, Platform", "Peachtree Analytics"],
      [LEVER_JOB_URL, "lever", "Data Engineer", "northwindlabs"],
      [ASHBY_JOB_URL, "ashby", "Staff Backend Engineer", "lumenworks"],
    ])("saves %s as a %s job", async (url, kind, title, company) => {
      const fake = fakeAtsFetch();
      const result = await addJobFromUrl({ db: db.client, fetch: fake.fetch }, url);
      expect(result).toMatchObject({ ok: true, created: true, job: { sourceUrl: url, sourceKind: kind, title, company, status: "saved" } });
      expect(await jobCount()).toBe(1);
    });

    it("the same job twice returns the existing one without fetching again", async () => {
      const fake = fakeAtsFetch();
      const first = await addJobFromUrl({ db: db.client, fetch: fake.fetch }, GREENHOUSE_JOB_URL);
      const second = await addJobFromUrl(
        { db: db.client, fetch: fake.fetch },
        "https://boards.greenhouse.io/peachtreeanalytics/jobs/4012345678?gh_src=linkedin",
      );
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      expect(fake.calls).toEqual([GREENHOUSE_API_URL]);
      expect(await jobCount()).toBe(1);
    });

    it("a differently cased, zero-padded link to a saved job is the same job", async () => {
      const fake = fakeAtsFetch();
      const first = await addJobFromUrl({ db: db.client, fetch: fake.fetch }, GREENHOUSE_JOB_URL);
      const second = await addJobFromUrl(
        { db: db.client, fetch: fake.fetch },
        "https://boards.greenhouse.io/PeachtreeAnalytics/jobs/004012345678",
      );
      expect(first.ok && second.ok && second.created === false && second.job.id === first.job.id).toBe(true);
      expect(fake.calls).toEqual([GREENHOUSE_API_URL]);
      expect(await jobCount()).toBe(1);
    });

    it("two adds of the same job at the same moment make ONE request and ONE job", async () => {
      const fake = fakeAtsFetch();
      const deps = { db: db.client, fetch: fake.fetch };
      const [a, b] = await Promise.all([
        addJobFromUrl(deps, GREENHOUSE_JOB_URL),
        addJobFromUrl(deps, "https://boards.greenhouse.io/PeachtreeAnalytics/jobs/4012345678?gh_src=x"),
      ]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.job.id).toBe(b.job.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(fake.calls).toEqual([GREENHOUSE_API_URL]);
      expect(await jobCount()).toBe(1);
    });

    it("a wrong-case Lever link (Lever's API is case-sensitive) can't make a valid add at the same moment fail", async () => {
      const fake = fakeAtsFetch(); // serves only the correctly cased northwindlabs URL
      const wrongCase = LEVER_JOB_URL.replace("northwindlabs", "NorthwindLabs");
      const [wrong, valid] = await Promise.all([
        addJobFromUrl({ db: db.client, fetch: fake.fetch }, wrongCase),
        addJobFromUrl({ db: db.client, fetch: fake.fetch }, LEVER_JOB_URL),
      ]);
      expect(valid).toMatchObject({ ok: true, created: true, job: { title: "Data Engineer" } });
      expect(wrong).toEqual({ ok: false, message: SOURCE_MESSAGES.notFound });
      expect(await jobCount()).toBe(1);
    });

    it("two DIFFERENT jobs on the same Ashby board added at once are two jobs (only Lever shares by API URL)", async () => {
      const fake = fakeAtsFetch();
      const otherJob = "https://jobs.ashbyhq.com/lumenworks/8a7b6c5d-1e2f-4a3b-9c8d-7e6f5a4b3c2d";
      const [a, b] = await Promise.all([
        addJobFromUrl({ db: db.client, fetch: fake.fetch }, ASHBY_JOB_URL),
        addJobFromUrl({ db: db.client, fetch: fake.fetch }, otherJob),
      ]);
      expect(a).toMatchObject({ ok: true, created: true, job: { title: "Staff Backend Engineer" } });
      expect(b).toMatchObject({ ok: true, created: true, job: { title: "Product Designer" } });
      expect(fake.calls).toHaveLength(2);
      expect(await jobCount()).toBe(2);
    });

    it("a failed add frees the link, so the next try fetches again", async () => {
      const failing = fakeFetch({});
      const results = await Promise.all([
        addJobFromUrl({ db: db.client, fetch: failing.fetch }, LEVER_JOB_URL),
        addJobFromUrl({ db: db.client, fetch: failing.fetch }, LEVER_JOB_URL),
      ]);
      expect(results).toEqual([
        { ok: false, message: SOURCE_MESSAGES.notFound },
        { ok: false, message: SOURCE_MESSAGES.notFound },
      ]);
      expect(failing.calls).toHaveLength(1);
      const retry = fakeAtsFetch();
      expect(await addJobFromUrl({ db: db.client, fetch: retry.fetch }, LEVER_JOB_URL)).toMatchObject({ ok: true, created: true });
      expect(retry.calls).toHaveLength(1);
    });

    it("any other site: the paste message, no request, nothing saved", async () => {
      const fake = fakeAtsFetch();
      const result = await addJobFromUrl({ db: db.client, fetch: fake.fetch }, "https://www.linkedin.com/jobs/view/123");
      expect(result).toEqual({ ok: false, message: CANT_READ_SITE });
      expect(fake.calls).toEqual([]);
      expect(await jobCount()).toBe(0);
    });

    it("a closed job: the not-found message, nothing saved", async () => {
      const result = await addJobFromUrl({ db: db.client, fetch: fakeFetch({}).fetch }, LEVER_JOB_URL);
      expect(result).toEqual({ ok: false, message: SOURCE_MESSAGES.notFound });
      expect(await jobCount()).toBe(0);
    });
  });

  describe("from pasted text", () => {
    it("saves it as a pasted job", async () => {
      const result = await addJobFromText({ db: db.client }, { text: JD, title: "Staff Engineer" });
      expect(result).toMatchObject({
        ok: true,
        created: true,
        job: { sourceUrl: null, sourceKind: "paste", title: "Staff Engineer", company: null, description: JD, status: "saved" },
      });
      expect(await jobCount()).toBe(1);
    });

    it("rejects text that is too short and saves nothing", async () => {
      const result = await addJobFromText({ db: db.client }, { text: "Too short." });
      expect(result.ok).toBe(false);
      expect(await jobCount()).toBe(0);
    });
  });
});
