// Score math for the fit check (PRD 01 §2 story 4). These tests ARE the definition of the two
// scores: anyone rewriting src/domain/fit-score.ts (an optional TypeScript exercise) only has
// to keep this file green.
//
// - JD match %: each requirement scores met = 1, partial = 0.5, missing = 0; the score is the
//   average × 100.
// - Your-criteria %: each criterion scores met = 1, unclear = 0.5, not_met = 0; same average.
//   No criteria at all → null ("no criteria" is not "meets none of them").
// - Strict JD % ("employer view", step 11): only met counts (met = 1, partial = 0, missing = 0);
//   average × 100. Shown beside JD match %, never instead of it.
// - All are rounded to 2 decimals, halves rounded up, to fit the numeric(5,2) columns.
import { describe, expect, it } from "vitest";
import {
  CRITERION_POINTS,
  criteriaMatchPct,
  jdMatchPct,
  isWeakGo,
  REQUIREMENT_POINTS,
  STRICT_REQUIREMENT_POINTS,
  strictJdMatchPct,
  WEAK_GO_BELOW_JD_PCT,
} from "../../src/domain/fit-score.js";

describe("points per status", () => {
  it("scores requirements met = 1, partial = 0.5, missing = 0", () => {
    expect(REQUIREMENT_POINTS).toEqual({ met: 1, partial: 0.5, missing: 0 });
  });

  it("scores criteria met = 1, unclear = 0.5, not_met = 0", () => {
    expect(CRITERION_POINTS).toEqual({ met: 1, unclear: 0.5, not_met: 0 });
  });
});

describe("jdMatchPct", () => {
  it("is 100 when every requirement is met", () => {
    expect(jdMatchPct(["met", "met", "met"])).toBe(100);
  });

  it("is 0 when every requirement is missing", () => {
    expect(jdMatchPct(["missing", "missing"])).toBe(0);
  });

  it("counts a partial as half", () => {
    expect(jdMatchPct(["partial"])).toBe(50);
    expect(jdMatchPct(["met", "partial", "missing", "missing"])).toBe(37.5);
  });

  it("rounds to 2 decimals", () => {
    expect(jdMatchPct(["met", "missing", "missing"])).toBe(33.33);
    expect(jdMatchPct(["met", "met", "missing"])).toBe(66.67);
    expect(jdMatchPct(["partial", "missing", "missing"])).toBe(16.67);
  });

  it("rounds a half up (3.125 → 3.13, 0.625 → 0.63)", () => {
    // One partial among 16 requirements: 0.5 / 16 = 3.125 %.
    expect(jdMatchPct(["partial", ...Array<"missing">(15).fill("missing")])).toBe(3.13);
    // One partial among 80: 0.625 %.
    expect(jdMatchPct(["partial", ...Array<"missing">(79).fill("missing")])).toBe(0.63);
  });

  it("does not depend on the order of the requirements", () => {
    expect(jdMatchPct(["missing", "met", "partial"])).toBe(jdMatchPct(["partial", "missing", "met"]));
  });

  it("stays exact for a long list", () => {
    const statuses = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? "met" : "partial"));
    expect(jdMatchPct(statuses)).toBe(75);
  });

  it("refuses an empty list (a fit check always has at least one requirement)", () => {
    expect(() => jdMatchPct([])).toThrow(RangeError);
  });
});

describe("strictJdMatchPct (employer view: share of requirements met, partial and missing count 0)", () => {
  it("scores met = 1, partial = 0, missing = 0", () => {
    expect(STRICT_REQUIREMENT_POINTS).toEqual({ met: 1, partial: 0, missing: 0 });
  });

  it("is 100 when every requirement is met and 0 when none is", () => {
    expect(strictJdMatchPct(["met", "met"])).toBe(100);
    expect(strictJdMatchPct(["missing", "missing"])).toBe(0);
  });

  it("counts a partial as 0, not half", () => {
    expect(strictJdMatchPct(["partial"])).toBe(0);
    expect(strictJdMatchPct(["partial", "partial", "partial"])).toBe(0);
    expect(strictJdMatchPct(["met", "partial", "missing", "missing"])).toBe(25);
  });

  it("is never above the JD match % for the same statuses", () => {
    const lists: ("met" | "partial" | "missing")[][] = [
      ["met", "partial"],
      ["partial", "missing", "met"],
      ["met"],
      ["partial"],
    ];
    for (const statuses of lists) expect(strictJdMatchPct(statuses)).toBeLessThanOrEqual(jdMatchPct(statuses));
  });

  it("equals the JD match % when there is no partial", () => {
    expect(strictJdMatchPct(["met", "missing", "missing"])).toBe(jdMatchPct(["met", "missing", "missing"]));
  });

  it("rounds to 2 decimals", () => {
    expect(strictJdMatchPct(["met", "partial", "missing"])).toBe(33.33);
    expect(strictJdMatchPct(["met", "met", "partial"])).toBe(66.67);
    expect(strictJdMatchPct(["met", "partial", "partial", "missing", "missing", "missing"])).toBe(16.67);
  });

  it("rounds a half up (1/16 = 6.25 stays exact; 1/32 = 3.125 → 3.13; 1/160 = 0.625 → 0.63)", () => {
    expect(strictJdMatchPct(["met", ...Array<"partial">(15).fill("partial")])).toBe(6.25);
    expect(strictJdMatchPct(["met", ...Array<"partial">(31).fill("partial")])).toBe(3.13);
    expect(strictJdMatchPct(["met", ...Array<"missing">(159).fill("missing")])).toBe(0.63);
  });

  it("does not depend on the order of the requirements", () => {
    expect(strictJdMatchPct(["missing", "met", "partial"])).toBe(strictJdMatchPct(["partial", "missing", "met"]));
  });

  it("stays exact for a long list", () => {
    const statuses = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? "met" : "partial"));
    expect(strictJdMatchPct(statuses)).toBe(50);
  });

  it("refuses an empty list, like jdMatchPct", () => {
    expect(() => strictJdMatchPct([])).toThrow(RangeError);
  });
});

describe("criteriaMatchPct", () => {
  it("is null when there are no criteria", () => {
    expect(criteriaMatchPct([])).toBeNull();
  });

  it("is 100 when every criterion is met and 0 when none is", () => {
    expect(criteriaMatchPct(["met", "met"])).toBe(100);
    expect(criteriaMatchPct(["not_met", "not_met", "not_met"])).toBe(0);
  });

  it("counts unclear as half", () => {
    expect(criteriaMatchPct(["unclear"])).toBe(50);
    expect(criteriaMatchPct(["met", "unclear"])).toBe(75);
  });

  it("rounds to 2 decimals, halves up", () => {
    expect(criteriaMatchPct(["met", "not_met", "not_met"])).toBe(33.33);
    expect(criteriaMatchPct(["met", "met", "unclear", "not_met", "not_met"])).toBe(50);
    expect(criteriaMatchPct(["unclear", "not_met", "not_met"])).toBe(16.67);
  });
});

describe("isWeakGo (a flag beside the model's recommendation; the recommendation itself is never changed)", () => {
  it("flags a go whose JD match, after the quote check, is under 50 %", () => {
    expect(WEAK_GO_BELOW_JD_PCT).toBe(50);
    expect(isWeakGo("go", 49.99)).toBe(true);
    expect(isWeakGo("go", 0)).toBe(true);
  });

  it("does not flag a go at 50 % or more", () => {
    expect(isWeakGo("go", 50)).toBe(false);
    expect(isWeakGo("go", 100)).toBe(false);
  });

  it("never flags maybe or skip", () => {
    expect(isWeakGo("maybe", 0)).toBe(false);
    expect(isWeakGo("skip", 10)).toBe(false);
  });
});
