// SQL for the master_resume_versions table: save a new version, read one back.
// Like a small repository class in .NET, but as plain functions that take the database as a parameter.
import { isUniqueViolation, type Queryable } from "./database.js";

export interface SavedResume {
  version: number;
  text: string;
  savedAt: Date;
}

// The name Postgres gave the UNIQUE (version) constraint in 001_init.sql (<table>_<column>_key).
const VERSION_UNIQUE_CONSTRAINT = "master_resume_versions_version_key";

// How many times a save is tried when another save takes the same version number first.
// A single user saving from one chat will almost never collide even once.
export const MAX_SAVE_ATTEMPTS = 5;

/** Thrown when every attempt collided with another save. The message is shown to the user. */
export class SaveCollisionError extends Error {
  override name = "SaveCollisionError";
  constructor() {
    super("Another save happened at the same moment. Please try again.");
  }
}

/**
 * Saves `text` as a new version (the latest version + 1). Never updates an existing row.
 *
 * Concurrency: two saves at the same moment can both read the same "latest version" and both try
 * to insert, say, version 4. The UNIQUE constraint on version lets only one win; the other gets a
 * unique-violation error, and we simply try again, which then picks version 5. This is optimistic
 * concurrency (like catching DbUpdateConcurrencyException in EF Core and retrying). It needs no
 * explicit transaction or lock, so it works the same with a connection pool or a single connection.
 */
export async function saveMasterResume(db: Queryable, text: string): Promise<SavedResume> {
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
    try {
      // One statement: work out the next version and insert it. COALESCE turns "no rows yet" (NULL) into 0.
      const result = await db.query<{ version: number; text: string; created_at: Date }>(
        `INSERT INTO master_resume_versions (version, text)
         SELECT COALESCE(MAX(version), 0) + 1, $1 FROM master_resume_versions
         RETURNING version, text, created_at`,
        [text],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Saving the résumé returned no row."); // can't happen: INSERT ... RETURNING always returns the row
      return { version: row.version, text: row.text, savedAt: row.created_at };
    } catch (err) {
      // Only our own version collision is retried; anything else (database down, ...) goes up as it is.
      if (!isUniqueViolation(err, VERSION_UNIQUE_CONSTRAINT)) throw err;
    }
  }
  throw new SaveCollisionError();
}

/** The given version, or the latest when `version` is undefined. `undefined` if there is no such row. */
export async function getMasterResume(db: Queryable, version?: number): Promise<SavedResume | undefined> {
  // `$1::int IS NULL` makes one query serve both cases: no version → just take the highest.
  const result = await db.query<{ version: number; text: string; created_at: Date }>(
    `SELECT version, text, created_at FROM master_resume_versions
     WHERE $1::int IS NULL OR version = $1::int
     ORDER BY version DESC
     LIMIT 1`,
    [version ?? null],
  );
  const row = result.rows[0];
  return row ? { version: row.version, text: row.text, savedAt: row.created_at } : undefined;
}

/** The highest saved version number, or `undefined` when nothing has been saved. */
export async function latestMasterResumeVersion(db: Queryable): Promise<number | undefined> {
  const result = await db.query<{ version: number | null }>("SELECT MAX(version) AS version FROM master_resume_versions");
  return result.rows[0]?.version ?? undefined;
}
