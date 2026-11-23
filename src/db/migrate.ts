// A small hand-written migration runner (no library), so every step is visible.
//
// Rules for migration files in migrations/:
// - Name: a number, an underscore, a description: 001_init.sql, 002_add_x.sql. Files run in
//   numeric order (so 1000_ runs after 999_). We zero-pad to three digits by convention.
// - Never edit a file once it has been applied anywhere; add a new file instead.
// - Do NOT put BEGIN/COMMIT in a file: the runner wraps each file in its own transaction,
//   together with the row that records it, so a file is either fully applied and recorded,
//   or not at all.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// `import type` brings in only the TypeScript types (erased at compile time), not the library code.
// This file just needs the pg.Client type; the caller creates the actual connection.
import type pg from "pg";

// migrations/ sits at the repo root, two folders up from src/db/ (and from dist/db/).
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** The leading number of a migration filename ("012_add_x.sql" → 12). Throws on a bad name. */
function migrationNumber(file: string): number {
  const match = /^(\d+)_/.exec(file);
  if (!match?.[1]) {
    throw new Error(`Migration file name must start with a number and an underscore (like 002_add_x.sql): ${file}`);
  }
  return Number(match[1]);
}

/** Pure ordering rule: the .sql files not yet applied, in numeric order (then by name). */
export function pendingMigrations(files: string[], alreadyApplied: Set<string>): string[] {
  const sqlFiles = files.filter((file) => file.endsWith(".sql"));
  // Validate every name up front. Don't rely on the sort comparator to do it: sort() never
  // calls the comparator for a list of one, so a lone badly named file would slip through.
  for (const file of sqlFiles) migrationNumber(file);

  return sqlFiles
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b))
    .filter((file) => !alreadyApplied.has(file));
}

// Two migrations at the same moment (say two `npm run db:seed` on a new database) would both see
// nothing applied, both run 001, and one would crash on a duplicate type name. A session-level
// advisory lock, keyed by name, makes them take turns: the second waits, then finds 001 recorded
// and applies nothing (step 9 review M1). It is per database, so migrations in other schemas of
// the same database also take turns, which only costs them a short wait.
const MIGRATE_LOCK = "job-tracker-mcp:migrate";

/** Applies pending migrations. Returns the filenames it applied (empty if none were pending). */
export async function migrate(client: pg.Client, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATE_LOCK]);
  try {
    return await applyPending(client, dir);
  } finally {
    // A dead connection has already dropped the lock; don't let this hide the real error.
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATE_LOCK]).catch(() => undefined);
  }
}

async function applyPending(client: pg.Client, dir: string): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const done = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const pending = pendingMigrations(readdirSync(dir), new Set(done.rows.map((row) => row.filename)));

  const applied: string[] = [];
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file} failed and was rolled back: ${reason}`, { cause: err });
    }
    applied.push(file);
  }
  return applied;
}
