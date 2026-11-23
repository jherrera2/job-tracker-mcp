// "Sync tests": each lookup table in the database must match its TypeScript list in
// src/db/lookups.ts exactly, so the two can never drift apart unnoticed.
import { beforeEach, describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  JOB_STATUS_LABELS,
  RECOMMENDATIONS,
  RECOMMENDATION_LABELS,
  SOURCE_KINDS,
  SOURCE_KIND_LABELS,
} from "../../src/db/lookups.js";
import { migrate } from "../../src/db/migrate.js";
import { openTestDb, type TestDb } from "./db-helpers.js";

interface LookupRow {
  code: string;
  label: string;
  sort_order?: number;
}

describe("lookup tables match src/db/lookups.ts", () => {
  let db: TestDb;

  // The function returned from beforeEach is Vitest's per-test teardown. It is only registered
  // if setup succeeded, and it closes over THIS test's handle, so a failed setup can never
  // make teardown touch a previous test's (already closed) connection.
  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    await migrate(opened.client);
    return () => opened.cleanup();
  });

  it("job_statuses: same codes, labels and order", async () => {
    const rows = await db.client.query<LookupRow>("SELECT code, label, sort_order FROM job_statuses ORDER BY sort_order");
    expect(rows.rows).toEqual(
      JOB_STATUSES.map((code, i) => ({ code, label: JOB_STATUS_LABELS[code], sort_order: i + 1 })),
    );
  });

  it("recommendations: same codes, labels and order", async () => {
    const rows = await db.client.query<LookupRow>(
      "SELECT code, label, sort_order FROM recommendations ORDER BY sort_order",
    );
    expect(rows.rows).toEqual(
      RECOMMENDATIONS.map((code, i) => ({ code, label: RECOMMENDATION_LABELS[code], sort_order: i + 1 })),
    );
  });

  it("source_kinds: same codes and labels", async () => {
    const rows = await db.client.query<LookupRow>("SELECT code, label FROM source_kinds ORDER BY code");
    const expected = [...SOURCE_KINDS].sort().map((code) => ({ code, label: SOURCE_KIND_LABELS[code] }));
    expect(rows.rows).toEqual(expected);
  });
});
