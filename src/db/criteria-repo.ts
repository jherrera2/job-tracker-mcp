// SQL for the criteria table: replace the whole set, read it back.
import { inTransaction, type Queryable } from "./database.js";
import type { CriterionInput } from "../domain/criteria.js";

export interface SavedCriterion {
  position: number;
  label: string;
  detail: string;
  updatedAt: Date;
}

interface CriterionRow {
  position: number;
  label: string;
  detail: string;
  updated_at: Date;
}

const toSaved = (row: CriterionRow): SavedCriterion => ({
  position: row.position,
  label: row.label,
  detail: row.detail,
  updatedAt: row.updated_at,
});

/**
 * Replaces the saved set with `criteria` (already validated), at positions 1..n in the given order.
 * Returns the new set in position order.
 *
 * Delete + insert run in ONE transaction, so a failure part-way leaves the old set untouched and a
 * reader never sees a half-saved set.
 *
 * Two saves at the same moment: each would delete the rows it can see and insert positions 1..n,
 * and the second insert would hit the UNIQUE (position) constraint on rows the first just committed.
 * Locking the table first makes the second save wait until the first has committed; it then
 * replaces that set whole. The lock mode (EXCLUSIVE) blocks other writers but still lets
 * get_criteria read (the old set until the save commits).
 */
export async function replaceCriteria(db: Queryable, criteria: readonly CriterionInput[]): Promise<SavedCriterion[]> {
  return inTransaction(db, async (tx) => {
    await tx.query("LOCK TABLE criteria IN EXCLUSIVE MODE");
    await tx.query("DELETE FROM criteria");
    // unnest(...) WITH ORDINALITY turns the two arrays into rows numbered 1, 2, 3...: the positions.
    // One INSERT for the whole set; the CTE lets us return the rows sorted.
    const result = await tx.query<CriterionRow>(
      `WITH inserted AS (
         INSERT INTO criteria (position, label, detail)
         SELECT position, label, detail
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(label, detail, position)
         RETURNING position, label, detail, updated_at
       )
       SELECT position, label, detail, updated_at FROM inserted ORDER BY position`,
      [criteria.map((c) => c.label), criteria.map((c) => c.detail)],
    );
    return result.rows.map(toSaved);
  });
}

/** The saved set in position order; an empty list when nothing is saved. */
export async function getCriteria(db: Queryable): Promise<SavedCriterion[]> {
  const result = await db.query<CriterionRow>(
    "SELECT position, label, detail, updated_at FROM criteria ORDER BY position",
  );
  return result.rows.map(toSaved);
}
