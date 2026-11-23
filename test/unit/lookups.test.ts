import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  JobStatusSchema,
  RECOMMENDATIONS,
  RecommendationSchema,
  SOURCE_KINDS,
  SourceKindSchema,
} from "../../src/db/lookups.js";

describe("lookup lists (TypeScript side; test/integration/lookups-sync.test.ts checks them against the DB)", () => {
  it("lists the job statuses from PRD §2.5 in flow order", () => {
    expect(JOB_STATUSES).toEqual(["saved", "go", "skip", "applied", "interviewing", "offer", "closed"]);
  });

  it("lists the source kinds and recommendations", () => {
    expect(SOURCE_KINDS).toEqual(["greenhouse", "lever", "ashby", "paste"]);
    expect(RECOMMENDATIONS).toEqual(["go", "maybe", "skip"]);
  });

  it("builds Zod enums that accept every code and reject anything else", () => {
    for (const code of JOB_STATUSES) expect(JobStatusSchema.parse(code)).toBe(code);
    for (const code of SOURCE_KINDS) expect(SourceKindSchema.parse(code)).toBe(code);
    for (const code of RECOMMENDATIONS) expect(RecommendationSchema.parse(code)).toBe(code);
    expect(JobStatusSchema.safeParse("maybe").success).toBe(false);
    expect(SourceKindSchema.safeParse("linkedin").success).toBe(false);
    expect(RecommendationSchema.safeParse("apply").success).toBe(false);
  });
});
