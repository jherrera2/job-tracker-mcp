import pg from "pg";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/database.js";
import { MAX_SAVE_ATTEMPTS, SaveCollisionError, saveMasterResume } from "../../src/db/master-resume-repo.js";

// What Postgres throws when another save took the same version number first.
function versionCollision(): pg.DatabaseError {
  const err = new pg.DatabaseError('duplicate key value violates unique constraint "master_resume_versions_version_key"', 0, "error");
  err.code = "23505";
  err.constraint = "master_resume_versions_version_key";
  return err;
}

describe("saveMasterResume retries", () => {
  // The give-up path (decision 1 in PR #2): every attempt collides. The integration tests force
  // ONE real collision; forcing five in a row against Postgres would be flaky, so a fake db does it.
  it(`gives up after ${MAX_SAVE_ATTEMPTS} collisions with a try-again message`, async () => {
    let calls = 0;
    const alwaysCollides = {
      query: () => {
        calls++;
        return Promise.reject(versionCollision());
      },
    } as unknown as Queryable;

    const save = saveMasterResume(alwaysCollides, "résumé text");

    await expect(save).rejects.toBeInstanceOf(SaveCollisionError);
    await expect(save).rejects.toThrow("Another save happened at the same moment. Please try again.");
    expect(calls).toBe(5);
  });

  it("succeeds on the last attempt after 4 collisions", async () => {
    let calls = 0;
    const db = {
      query: () => {
        calls++;
        if (calls < 5) return Promise.reject(versionCollision());
        return Promise.resolve({ rows: [{ version: 7, text: "résumé text", created_at: new Date(0) }] });
      },
    } as unknown as Queryable;

    await expect(saveMasterResume(db, "résumé text")).resolves.toMatchObject({ version: 7 });
    expect(calls).toBe(5);
  });
});
