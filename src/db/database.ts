// The one thing the tools need from the database: "run this SQL with these parameters".
//
// Both pg.Pool (what the real server uses) and pg.Client (what the integration tests use, pointed
// at a throwaway schema) have this method, so either can be passed in. It plays the role an
// injected IDbConnection / DbContext plays in .NET: the code depends on the interface, and
// whoever builds the server decides which concrete object to hand over.
import pg from "pg";

export interface Queryable {
  // `R` is the row type the caller expects, like Dapper's Query<T>. pg does not check it at run
  // time, so the SQL and the type must agree.
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** The connection pool the real server uses. Connections open lazily, on the first query. */
export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // When an idle connection dies (say Postgres restarts), pg emits 'error' on the pool. Node kills
  // the process on an 'error' event nobody listens to, so log it to stderr (stdout carries the MCP
  // protocol) and carry on: the pool drops that connection and the next query opens a fresh one.
  pool.on("error", (err) => {
    console.error(`Lost an idle database connection: ${err.message}`);
  });
  return pool;
}

/** Postgres' error code for "duplicate value in a UNIQUE column" (unique_violation). */
export const UNIQUE_VIOLATION = "23505";

/** True if `err` is a Postgres unique violation on the named constraint. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  // pg puts Postgres' error fields (code, constraint, ...) on the Error object it throws.
  return err instanceof pg.DatabaseError && err.code === UNIQUE_VIOLATION && err.constraint === constraint;
}

/**
 * Runs `work` as ONE transaction: every query it makes through `tx` commits together, or none do
 * (like a TransactionScope in .NET). If `work` throws, the transaction is rolled back and the error
 * is rethrown.
 *
 * Why it needs to know pool from client: BEGIN, the work and COMMIT must all run on the SAME
 * connection. A pool hands each `query` to whichever connection is free, so for a pool we check
 * out one connection, use it for the whole transaction, then give it back. A single pg.Client (as
 * the integration tests pass in) is already one connection, so it is used as it is; it queues its
 * queries, so only one caller at a time should use it for transactions.
 */
export async function inTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (db instanceof OpenTransaction) return db.nested(work);
  if (!(db instanceof pg.Pool)) return runTransaction(db, work);

  const connection = await db.connect();
  let broken: Error | undefined;
  try {
    return await runTransaction(connection, work, (err) => (broken = err));
  } finally {
    // Passing an error to release() makes the pool discard the connection instead of reusing it.
    connection.release(broken);
  }
}

async function runTransaction<T>(
  connection: Queryable,
  work: (tx: Queryable) => Promise<T>,
  onRollbackFailed?: (err: Error) => void,
): Promise<T> {
  await connection.query("BEGIN");
  try {
    const result = await work(connection);
    await connection.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await connection.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection is in an unknown state (e.g. it died); report the ORIGINAL error.
      onRollbackFailed?.(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
    }
    throw err;
  }
}

/**
 * A connection that is ALREADY inside a transaction its caller began and will end (the demo seed,
 * src/demo/seed.ts, runs the tools in one transaction). inTransaction on it runs the work inside a
 * SAVEPOINT instead of BEGIN / COMMIT: a plain BEGIN there would only warn, and the inner COMMIT
 * would end the caller's transaction early. A failing inner unit rolls back to its savepoint, so
 * it still undoes only its own work, as it would on its own; the caller decides about the rest.
 *
 * Limits (review, step 9): only work run through inTransaction gets a savepoint. A plain .query()
 * that fails (say a unique-violation retry in saveMasterResume) aborts the CALLER's whole
 * transaction, so later queries fail until it rolls back. That is fine for the seed: it holds
 * EXCLUSIVE locks on every table it writes, so those collisions can't happen, and any failure
 * rolls the whole seed back anyway. It is also meant for ONE caller awaiting one query at a time
 * (like a pg.Client): two overlapping inTransaction calls would interleave their savepoints.
 */
export class OpenTransaction implements Queryable {
  constructor(private readonly connection: Queryable) {}

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.connection.query<R>(text, values);
  }

  /**
   * Runs `work` inside a savepoint (released on success; rolled back to, then released, on
   * failure). One name for every level is enough: Postgres lets a newer savepoint reuse a name,
   * and RELEASE / ROLLBACK TO act on the newest one, which is always this call's own because every
   * path releases it before returning.
   */
  async nested<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.connection.query("SAVEPOINT nested");
    try {
      const result = await work(this);
      await this.connection.query("RELEASE SAVEPOINT nested");
      return result;
    } catch (err) {
      // ROLLBACK TO keeps the savepoint, so release it too: otherwise an OUTER unit failing later
      // would roll back only to this inner savepoint and keep its own earlier work.
      // If either fails, the caller's transaction is broken anyway; report the ORIGINAL error.
      await this.connection.query("ROLLBACK TO SAVEPOINT nested").catch(() => undefined);
      await this.connection.query("RELEASE SAVEPOINT nested").catch(() => undefined);
      throw err;
    }
  }
}
