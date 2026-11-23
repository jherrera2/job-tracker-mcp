// SQL for the prompts table: read the current version, save an edit, reset to the shipped default.
//
// Every change is a NEW row (name, version + 1); no row is ever updated or deleted, so a fit check
// that recorded `prompt_version` can always be traced to the exact text it used (PRD §4).
//
// Version 1 of each prompt is always the shipped default. It is written the first time the prompt
// is read, edited or reset ("seeded on first use"), from the one constant in src/domain/prompts.ts,
// so the default text lives in TypeScript only and never has to be kept in step with a SQL seed.
import { isUniqueViolation, type Queryable } from "./database.js";
import { MAX_SAVE_ATTEMPTS, SaveCollisionError } from "./master-resume-repo.js";
import { DEFAULT_PROMPTS, type PromptName } from "../domain/prompts.js";

export interface SavedPrompt {
  name: PromptName;
  version: number;
  text: string;
  /** True when this row holds the shipped default (seeded or reset), false for a user's edit. */
  isDefault: boolean;
  savedAt: Date;
}

interface PromptRow {
  name: PromptName;
  version: number;
  text: string;
  is_default: boolean;
  created_at: Date;
}

// The name Postgres gave UNIQUE (name, version) in 001_init.sql (<table>_<columns>_key).
export const PROMPT_VERSION_UNIQUE_CONSTRAINT = "prompts_name_version_key";

const COLUMNS = "name, version, text, is_default, created_at";

function toSaved(row: PromptRow): SavedPrompt {
  return { name: row.name, version: row.version, text: row.text, isDefault: row.is_default, savedAt: row.created_at };
}

/**
 * Writes version 1 (the shipped default) if this prompt has no rows yet. Safe to run at the same
 * moment from several connections: the second insert waits on the UNIQUE index for the first to
 * commit, and ON CONFLICT DO NOTHING then turns it into a no-op instead of an error.
 */
async function ensureDefault(db: Queryable, name: PromptName): Promise<void> {
  await db.query(
    `INSERT INTO prompts (name, version, text, is_default)
     SELECT $1, 1, $2, true
     WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE name = $1)
     ON CONFLICT ON CONSTRAINT ${PROMPT_VERSION_UNIQUE_CONSTRAINT} DO NOTHING`,
    [name, DEFAULT_PROMPTS[name]],
  );
}

async function latest(db: Queryable, name: PromptName): Promise<SavedPrompt> {
  const result = await db.query<PromptRow>(
    `SELECT ${COLUMNS} FROM prompts WHERE name = $1 ORDER BY version DESC LIMIT 1`,
    [name],
  );
  const row = result.rows[0];
  // Can't happen: ensureDefault ran first and rows are never deleted.
  if (!row) throw new Error(`The ${name} prompt has no saved version.`);
  return toSaved(row);
}

/**
 * Runs one INSERT that picks the next version number, retrying when another save took that number
 * first. Same optimistic concurrency as saveMasterResume: UNIQUE (name, version) lets one save win,
 * the other runs its statement again (so it re-reads the latest row), up to MAX_SAVE_ATTEMPTS, then
 * SaveCollisionError. Nothing is overwritten or lost.
 */
async function withVersionRetry(run: () => Promise<PromptRow | undefined>): Promise<SavedPrompt> {
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
    try {
      const row = await run();
      if (!row) throw new Error("Saving the prompt returned no row."); // can't happen: see the callers' SQL
      return toSaved(row);
    } catch (err) {
      if (!isUniqueViolation(err, PROMPT_VERSION_UNIQUE_CONSTRAINT)) throw err;
    }
  }
  throw new SaveCollisionError();
}

/** The current (latest) version of the prompt. Seeds the shipped default on first use. */
export async function getPrompt(db: Queryable, name: PromptName): Promise<SavedPrompt> {
  await ensureDefault(db, name);
  return latest(db, name);
}

/** Saves the user's text as a new version. The default stays as version 1, so an edit is version 2 or later. */
export async function savePrompt(db: Queryable, name: PromptName, text: string): Promise<SavedPrompt> {
  await ensureDefault(db, name);
  return withVersionRetry(async () => {
    const result = await db.query<PromptRow>(
      `INSERT INTO prompts (name, version, text, is_default)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, false FROM prompts WHERE name = $1
       RETURNING ${COLUMNS}`,
      [name, text],
    );
    return result.rows[0];
  });
}

/**
 * Goes back to the shipped default by adding it as a new version (is_default = true), so the
 * history stays a straight line and every fit check's prompt_version still points at its text.
 * If the latest version already is the CURRENT shipped default, nothing is added and that version
 * is returned (resetting twice doesn't pile up identical versions).
 *
 * The check and the insert are ONE statement (tester M1): a separate "read latest, then insert"
 * let ten resets at once each see the edit and each add a default row. Here, two resets at once
 * both pick the same number; one wins, the other collides, runs the statement again, now sees the
 * winner's default row as the latest, inserts nothing and returns that row.
 */
export async function resetPrompt(db: Queryable, name: PromptName): Promise<SavedPrompt> {
  await ensureDefault(db, name);
  return withVersionRetry(async () => {
    const result = await db.query<PromptRow>(
      `WITH latest AS (
         SELECT ${COLUMNS} FROM prompts WHERE name = $1 ORDER BY version DESC LIMIT 1
       ),
       inserted AS (
         INSERT INTO prompts (name, version, text, is_default)
         SELECT $1, version + 1, $2, true FROM latest
         WHERE NOT (is_default AND text = $2)
         RETURNING ${COLUMNS}
       )
       SELECT ${COLUMNS} FROM inserted
       UNION ALL
       SELECT ${COLUMNS} FROM latest WHERE NOT EXISTS (SELECT 1 FROM inserted)`,
      [name, DEFAULT_PROMPTS[name]],
    );
    return result.rows[0];
  });
}

/** True when this exact version of the prompt is saved (versions are never deleted). */
export async function promptVersionExists(db: Queryable, name: PromptName, version: number): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM prompts WHERE name = $1 AND version = $2", [name, version]);
  return result.rows.length > 0;
}
