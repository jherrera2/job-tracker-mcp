// The demo data (step 9, `npm run db:seed`) checked against the SAME rules the tools apply, with no
// database: the résumé, criteria and pasted jobs pass their parsers, every fit answer passes the
// save_fit shape check and loses no quote to the word-for-word check, and the planned status moves
// are ones ALLOWED_MOVES allows. The integration test (test/integration/seed.test.ts) then stores it
// all through the real tools.
import { describe, expect, it } from "vitest";
import { DEMO_CRITERIA, DEMO_JOBS, DEMO_RESUME } from "../../src/demo/demo-data.js";
import { parseCriteria } from "../../src/domain/criteria.js";
import { matchCriteriaLabels, parseFitResult } from "../../src/domain/fit-result.js";
import { criteriaMatchPct, isWeakGo, jdMatchPct } from "../../src/domain/fit-score.js";
import { parsePastedJob } from "../../src/domain/job-paste.js";
import { checkStatusMove, INITIAL_JOB_STATUS } from "../../src/domain/job-status.js";
import { parseMasterResumeText } from "../../src/domain/master-resume.js";
import { checkEvidence } from "../../src/domain/quote-check.js";

describe("demo data", () => {
  it("is a fictional person: says so, and uses a reserved example.com address", () => {
    expect(DEMO_RESUME).toMatch(/fictional/i);
    const emails = DEMO_RESUME.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) expect(email).toMatch(/@example\.com$/);
  });

  it("every company is marked fictional in its posting", () => {
    for (const job of DEMO_JOBS) {
      expect(job.text, job.company).toContain(job.company);
      expect(job.text, job.company).toMatch(/fictional/i);
    }
  });

  it("the résumé passes set_master_resume's rules", () => {
    expect(parseMasterResumeText(DEMO_RESUME)).toEqual({ ok: true, text: DEMO_RESUME });
  });

  it("the criteria pass set_criteria's rules: 5, in the user's own words", () => {
    expect(DEMO_CRITERIA).toHaveLength(5);
    expect(parseCriteria(DEMO_CRITERIA)).toMatchObject({ ok: true });
  });

  it("about five jobs, each a pasted posting that passes add_job's paste rules", () => {
    expect(DEMO_JOBS.length).toBeGreaterThanOrEqual(4);
    expect(DEMO_JOBS.length).toBeLessThanOrEqual(6);
    for (const job of DEMO_JOBS) {
      expect(parsePastedJob({ text: job.text, title: job.title, company: job.company }), job.title).toMatchObject({ ok: true });
    }
    const keys = DEMO_JOBS.map((j) => `${j.title} @ ${j.company}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every fit answer passes save_fit's shape check and matches the saved criteria labels", () => {
    for (const job of DEMO_JOBS) {
      const parsed = parseFitResult(job.fit);
      expect(parsed, job.title).toMatchObject({ ok: true });
      if (!parsed.ok) continue;
      const matched = matchCriteriaLabels(
        parsed.result.criteria,
        DEMO_CRITERIA.map((c) => c.label),
      );
      expect(matched, job.title).toMatchObject({ ok: true });
    }
  });

  it("every evidence quote appears word for word in the demo résumé (none is dropped)", () => {
    for (const job of DEMO_JOBS) {
      const parsed = parseFitResult(job.fit);
      if (!parsed.ok) throw new Error(parsed.message);
      const { dropped } = checkEvidence(parsed.result.requirements, DEMO_RESUME);
      expect(dropped, job.title).toEqual([]);
    }
  });

  it("covers go, maybe and skip, including one weak go (scores computed by the real score code)", () => {
    const outcomes = DEMO_JOBS.map((job) => {
      const parsed = parseFitResult(job.fit);
      if (!parsed.ok) throw new Error(parsed.message);
      const jd = jdMatchPct(parsed.result.requirements.map((r) => r.status));
      return { recommendation: parsed.result.recommendation, weakGo: isWeakGo(parsed.result.recommendation, jd), jd };
    });
    const recommendations = outcomes.map((o) => o.recommendation);
    expect(recommendations).toContain("go");
    expect(recommendations).toContain("maybe");
    expect(recommendations).toContain("skip");
    expect(outcomes.filter((o) => o.weakGo)).toHaveLength(1);
    expect(outcomes.some((o) => o.recommendation === "go" && !o.weakGo)).toBe(true);
    // Criteria scores are numbers (criteria are saved), never null.
    for (const job of DEMO_JOBS) {
      const parsed = parseFitResult(job.fit);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(criteriaMatchPct(parsed.result.criteria.map((c) => c.status))).not.toBeNull();
    }
  });

  it("plans status moves ALLOWED_MOVES allows, with one applied and one skipped with a reason", () => {
    for (const job of DEMO_JOBS) {
      let from = INITIAL_JOB_STATUS;
      for (const move of job.moves) {
        expect(checkStatusMove(from, move.status, move.note ?? null), `${job.title}: ${from} → ${move.status}`).toEqual({ ok: true });
        from = move.status;
      }
    }
    const finals = DEMO_JOBS.map((j) => j.moves.at(-1)?.status ?? INITIAL_JOB_STATUS);
    expect(finals).toContain("applied");
    expect(finals).toContain("skip");
    expect(finals).toContain(INITIAL_JOB_STATUS);
    const skip = DEMO_JOBS.flatMap((j) => j.moves).find((m) => m.status === "skip");
    expect(skip?.note?.trim()).toBeTruthy();
  });
});
