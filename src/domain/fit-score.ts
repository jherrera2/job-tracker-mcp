// The two fit-check scores (PRD 01 §2 story 4). Computed here, by code, from the statuses in the
// chat model's answer AFTER the quote check; any score the model sends is never read (ADR-004).
//
// This module is deliberately small, pure and on its own: test/unit/fit-score.test.ts defines it
// completely, so it can be rewritten from the tests alone.
//
// - JD match %: requirements score met = 1, partial = 0.5, missing = 0; average × 100.
// - Your-criteria %: criteria score met = 1, unclear = 0.5, not_met = 0; average × 100.
//   No criteria → null: "no criteria saved" is not the same as "meets none of them" (0).
// - Strict JD % ("employer view", step 11): requirements score met = 1, partial = 0, missing = 0;
//   average × 100. The share of the posting's requirements the résumé plainly meets, modelled on
//   an applicant-tracking review where each criterion is meets / does not meet / undecided and
//   recruiters sort by "% of criteria met". Shown BESIDE the JD match %, never instead of it.
// - Rounded to 2 decimals, halves up, to fit the numeric(5,2) columns.

export type RequirementStatus = "met" | "partial" | "missing";
export type CriterionStatus = "met" | "unclear" | "not_met";

export const REQUIREMENT_POINTS: Readonly<Record<RequirementStatus, number>> = { met: 1, partial: 0.5, missing: 0 };
/** Employer view: only "met" counts. */
export const STRICT_REQUIREMENT_POINTS: Readonly<Record<RequirementStatus, number>> = { met: 1, partial: 0, missing: 0 };
export const CRITERION_POINTS: Readonly<Record<CriterionStatus, number>> = { met: 1, unclear: 0.5, not_met: 0 };

/** JD match % for a non-empty list of requirement statuses. */
export function jdMatchPct(statuses: readonly RequirementStatus[]): number {
  if (statuses.length === 0) throw new RangeError("A fit check needs at least one requirement to score.");
  return averagePct(statuses.map((status) => REQUIREMENT_POINTS[status]));
}

/** Strict JD % (employer view) for a non-empty list of requirement statuses: the share that are "met". */
export function strictJdMatchPct(statuses: readonly RequirementStatus[]): number {
  if (statuses.length === 0) throw new RangeError("A fit check needs at least one requirement to score.");
  return averagePct(statuses.map((status) => STRICT_REQUIREMENT_POINTS[status]));
}

/** Your-criteria % for the criterion statuses; null when there are none. */
export function criteriaMatchPct(statuses: readonly CriterionStatus[]): number | null {
  if (statuses.length === 0) return null;
  return averagePct(statuses.map((status) => CRITERION_POINTS[status]));
}

/**
 * Average of points between 0 and 1, as a percentage rounded to 2 decimals (halves up).
 *
 * Every point value is a multiple of 0.5, so the sum is counted in exact half-points (an integer),
 * and the percentage × 100 is one integer division: halfPoints × 5000 / n. Math.round on that
 * single, correctly rounded division gives exact half-up rounding (3.125 → 3.13); averaging floats
 * first could land on 3.1249999… and round the wrong way.
 */
function averagePct(points: readonly number[]): number {
  const halfPoints = points.reduce((sum, p) => sum + p * 2, 0);
  return Math.round((halfPoints * 5000) / points.length) / 100;
}

/** A "go" whose JD match is below this (after the quote check) is flagged as a weak go. */
export const WEAK_GO_BELOW_JD_PCT = 50;

/**
 * True when the model recommended "go" but, after the quote check, the user meets less than half
 * of the job's requirements. A flag shown BESIDE the recommendation: code never rewrites what the
 * model recommended (DECISIONS, step 6).
 */
export function isWeakGo(recommendation: "go" | "maybe" | "skip", jdPct: number): boolean {
  return recommendation === "go" && jdPct < WEAK_GO_BELOW_JD_PCT;
}
