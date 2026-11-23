// The seed checks every demo fit BEFORE it touches the database (src/demo/seed.ts checkDemoFits),
// so a broken demo stops with a sentence naming the job and the problem. A database stand-in that
// throws on any query proves no query ran first. No real database needed.
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { DEMO_JOBS, type DemoJob } from "../../src/demo/demo-data.js";
import { seedDemo } from "../../src/demo/seed.js";

const untouchable = {
  query: () => {
    throw new Error("The database was touched.");
  },
} as unknown as pg.ClientBase;

const firstJob = (): DemoJob => {
  const job = DEMO_JOBS[0];
  if (!job) throw new Error("no demo jobs");
  return job;
};

describe("seedDemo's check of the demo fits", () => {
  it("a quote that isn't in the demo résumé: a clear error naming the job and the quote, before any query", async () => {
    const requirement = firstJob().fit.requirements.find((r) => r.evidence_quote !== undefined);
    if (!requirement) throw new Error("no quoted requirement");
    const original = requirement.evidence_quote;
    requirement.evidence_quote = "Led a team of 40 engineers on a moon base";
    try {
      const error = await seedDemo(untouchable, { databaseUrl: "unused" }).catch((err: unknown) => err);
      expect(String(error)).toContain(`"${firstJob().title}"`);
      expect(String(error)).toContain("Led a team of 40 engineers on a moon base");
      expect(String(error)).not.toContain("The database was touched");
    } finally {
      requirement.evidence_quote = original;
    }
  });

  it("a malformed fit: a clear error naming the job, before any query", async () => {
    const fit = firstJob().fit;
    const original = fit.recommendation;
    (fit as { recommendation: string }).recommendation = "absolutely";
    try {
      const error = await seedDemo(untouchable, { databaseUrl: "unused" }).catch((err: unknown) => err);
      expect(String(error)).toMatch(/malformed/);
      expect(String(error)).toContain(`"${firstJob().title}"`);
      expect(String(error)).not.toContain("The database was touched");
    } finally {
      fit.recommendation = original;
    }
  });

  it("with the real demo data, the first thing it does is use the database", async () => {
    await expect(seedDemo(untouchable, { databaseUrl: "unused" })).rejects.toThrow("The database was touched.");
  });
});
