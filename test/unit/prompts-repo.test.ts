import pg from "pg";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/database.js";
import { MAX_SAVE_ATTEMPTS, SaveCollisionError } from "../../src/db/master-resume-repo.js";
import { PROMPT_VERSION_UNIQUE_CONSTRAINT, savePrompt } from "../../src/db/prompts-repo.js";

// What Postgres throws when another save took the same (name, version) first.
function versionCollision(): pg.DatabaseError {
  const err = new pg.DatabaseError(`duplicate key value violates unique constraint "${PROMPT_VERSION_UNIQUE_CONSTRAINT}"`, 0, "error");
  err.code = "23505";
  err.constraint = PROMPT_VERSION_UNIQUE_CONSTRAINT;
  return err;
}

/** A fake db: the new-version INSERT (the one that reads MAX(version)) collides `collisions` times. */
function collidingDb(collisions: number) {
  let versionInserts = 0;
  const db = {
    query: (sql: string) => {
      if (!sql.includes("MAX(version)")) return Promise.resolve({ rows: [] }); // the "make sure version 1 exists" step
      versionInserts++;
      if (versionInserts <= collisions) return Promise.reject(versionCollision());
      return Promise.resolve({
        rows: [{ name: "fit_check", version: 7, text: "edited", is_default: false, created_at: new Date(0) }],
      });
    },
  } as unknown as Queryable;
  return { db, versionInserts: () => versionInserts };
}

describe("savePrompt retries (same approach as the master résumé, DECISIONS PR #2 decision 1)", () => {
  it("names the real UNIQUE (name, version) constraint from 001_init.sql", () => {
    expect(PROMPT_VERSION_UNIQUE_CONSTRAINT).toBe("prompts_name_version_key");
  });

  it(`gives up after ${MAX_SAVE_ATTEMPTS} collisions with a try-again message`, async () => {
    const fake = collidingDb(Infinity);
    const save = savePrompt(fake.db, "fit_check", "edited");

    await expect(save).rejects.toBeInstanceOf(SaveCollisionError);
    await expect(save).rejects.toThrow("Another save happened at the same moment. Please try again.");
    expect(fake.versionInserts()).toBe(MAX_SAVE_ATTEMPTS);
  });

  it("succeeds on the last attempt after 4 collisions", async () => {
    const fake = collidingDb(MAX_SAVE_ATTEMPTS - 1);
    await expect(savePrompt(fake.db, "fit_check", "edited")).resolves.toMatchObject({ version: 7, isDefault: false });
    expect(fake.versionInserts()).toBe(MAX_SAVE_ATTEMPTS);
  });

  it("does not retry other database errors", async () => {
    let versionInserts = 0;
    const db = {
      query: (sql: string) => {
        if (!sql.includes("MAX(version)")) return Promise.resolve({ rows: [] });
        versionInserts++;
        return Promise.reject(new Error("disk full"));
      },
    } as unknown as Queryable;

    await expect(savePrompt(db, "fit_check", "edited")).rejects.toThrow("disk full");
    expect(versionInserts).toBe(1);
  });
});
