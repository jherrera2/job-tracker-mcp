// The fixed value lists ("lookups") used in the database, mirrored in TypeScript.
//
// The database holds the same lists in lookup tables (job_statuses, source_kinds, ...) with
// foreign keys, so a bad value can't be stored. These TS copies give us compile-time types
// and Zod validators. test/integration/lookups-sync.test.ts fails if the two ever differ.
//
// `as const` makes TypeScript treat the array as a fixed tuple of exact strings
// ("saved" | "go" | ...) instead of plain string[]; that's what lets us derive a type from it,
// a bit like generating a C# enum from a list.
import { z } from "zod";

// ---- Job statuses (PRD §2.5) — order = sort_order in the DB ----
export const JOB_STATUSES = ["saved", "go", "skip", "applied", "interviewing", "offer", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JobStatusSchema = z.enum(JOB_STATUSES);
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  saved: "Saved",
  go: "Go",
  skip: "Skipped",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed (after applying)",
};

// Allowed moves between statuses are business rules, kept in code: see src/domain/job-status.ts.

// ---- Where a job came from ----
export const SOURCE_KINDS = ["greenhouse", "lever", "ashby", "paste"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  paste: "Pasted text",
};

// ---- Fit-check recommendation — order = sort_order in the DB ----
export const RECOMMENDATIONS = ["go", "maybe", "skip"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export const RecommendationSchema = z.enum(RECOMMENDATIONS);
export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  go: "Go",
  maybe: "Maybe",
  skip: "Skip",
};
