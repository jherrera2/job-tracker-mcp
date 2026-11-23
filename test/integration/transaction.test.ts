// inTransaction (src/db/database.ts): runs several queries as one all-or-nothing unit, on either a
// single pg.Client (the tests' connection) or a pg.Pool (the real server). Against real Postgres.
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inTransaction, OpenTransaction, type Queryable } from "../../src/db/database.js";
import { openTestDb, testDatabaseUrl, type TestDb } from "./db-helpers.js";

describe("inTransaction", () => {
  let db: TestDb;

  let cleanup: (() => Promise<void>) | undefined;

  // Cleanup is registered before CREATE TABLE runs, so a failing setup can't leak the schema.
  beforeEach(async () => {
    const opened = await openTestDb();
    cleanup = opened.cleanup;
    db = opened;
    await opened.client.query("CREATE TABLE things (name text NOT NULL)");
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function names(): Promise<string[]> {
    const result = await db.client.query<{ name: string }>("SELECT name FROM things ORDER BY name");
    return result.rows.map((r) => r.name);
  }

  function withPool(): pg.Pool {
    return new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 2 });
  }

  async function insertTwoThenFail(conn: Queryable): Promise<void> {
    await inTransaction(conn, async (tx) => {
      await tx.query("INSERT INTO things VALUES ('a')");
      await tx.query("INSERT INTO things VALUES ('b')");
      throw new Error("stop here");
    });
  }

  describe("on a single connection", () => {
    it("commits and returns the work's result", async () => {
      const result = await inTransaction(db.client, async (tx) => {
        await tx.query("INSERT INTO things VALUES ('a'), ('b')");
        return 42;
      });
      expect(result).toBe(42);
      expect(await names()).toEqual(["a", "b"]);
    });

    it("rolls everything back and rethrows when the work fails", async () => {
      await expect(insertTwoThenFail(db.client)).rejects.toThrow("stop here");
      expect(await names()).toEqual([]);
      // The connection is usable again (not stuck in an aborted transaction).
      await db.client.query("INSERT INTO things VALUES ('c')");
      expect(await names()).toEqual(["c"]);
    });
  });

  // The demo seed (step 9) runs the tools inside ONE transaction it owns; their own inTransaction
  // calls must then nest (a SAVEPOINT), not BEGIN/COMMIT, which would end the seed's transaction early.
  describe("inside a transaction the caller owns (OpenTransaction)", () => {
    it("does not commit the outer transaction: rolling the outer back removes the inner work too", async () => {
      await db.client.query("BEGIN");
      const open = new OpenTransaction(db.client);
      const result = await inTransaction(open, async (tx) => {
        await tx.query("INSERT INTO things VALUES ('a')");
        return 7;
      });
      await db.client.query("ROLLBACK");
      expect(result).toBe(7);
      expect(await names()).toEqual([]);
    });

    it("a failing inner unit rolls back only its own work; the outer transaction carries on and commits", async () => {
      await db.client.query("BEGIN");
      const open = new OpenTransaction(db.client);
      await open.query("INSERT INTO things VALUES ('outer')");
      await expect(insertTwoThenFail(open)).rejects.toThrow("stop here");
      await inTransaction(open, (tx) => tx.query("INSERT INTO things VALUES ('inner')"));
      await db.client.query("COMMIT");
      expect(await names()).toEqual(["inner", "outer"]);
    });

    it("nests more than one level", async () => {
      await db.client.query("BEGIN");
      const open = new OpenTransaction(db.client);
      await inTransaction(open, async (tx) => {
        await tx.query("INSERT INTO things VALUES ('a')");
        await expect(insertTwoThenFail(tx)).rejects.toThrow("stop here");
      });
      await db.client.query("COMMIT");
      expect(await names()).toEqual(["a"]);
    });
  });

  it("OpenTransaction: an outer unit failing after an inner one failed undoes ALL the outer work", async () => {
    await db.client.query("BEGIN");
    const open = new OpenTransaction(db.client);
    await expect(
      inTransaction(open, async (tx) => {
        await tx.query("INSERT INTO things VALUES ('outer')");
        await expect(insertTwoThenFail(tx)).rejects.toThrow("stop here");
        throw new Error("outer fails too");
      }),
    ).rejects.toThrow("outer fails too");
    await db.client.query("COMMIT");
    expect(await names()).toEqual([]);
  });

  it("OpenTransaction: an outer unit failing after an inner one SUCCEEDED undoes all the outer work", async () => {
    await db.client.query("BEGIN");
    const open = new OpenTransaction(db.client);
    await expect(
      inTransaction(open, async (tx) => {
        await tx.query("INSERT INTO things VALUES ('outer')");
        await inTransaction(tx, (inner) => inner.query("INSERT INTO things VALUES ('inner')"));
        throw new Error("outer fails");
      }),
    ).rejects.toThrow("outer fails");
    await db.client.query("COMMIT");
    expect(await names()).toEqual([]);
  });

  describe("on a pool", () => {
    it("runs every query on ONE connection and commits", async () => {
      const pool = withPool();
      try {
        const pids = await inTransaction(pool, async (tx) => {
          const first = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          await tx.query("INSERT INTO things VALUES ('a')");
          const second = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          return [first.rows[0]?.pid, second.rows[0]?.pid];
        });
        expect(pids[0]).toBe(pids[1]);
        expect(await names()).toEqual(["a"]);
      } finally {
        await pool.end();
      }
    });

    it("rolls back on failure and gives the connection back to the pool", async () => {
      const pool = withPool();
      try {
        await expect(insertTwoThenFail(pool)).rejects.toThrow("stop here");
        expect(await names()).toEqual([]);
        expect(pool.totalCount - pool.idleCount).toBe(0); // nothing still checked out
      } finally {
        await pool.end();
      }
    });

    it("gives the connection back after a commit", async () => {
      const pool = withPool();
      try {
        await inTransaction(pool, (tx) => tx.query("INSERT INTO things VALUES ('a')"));
        expect(pool.totalCount - pool.idleCount).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });
});
