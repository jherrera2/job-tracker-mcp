// Shared setup for integration tests. Not a test file itself (no ".test" in the name).
//
// Each test gets its own brand-new Postgres *schema* (a namespace inside the database),
// so tests never see each other's tables. Vitest runs test FILES in parallel (tests inside one
// file run one after another); separate schemas keep those files apart. The schema is dropped afterwards.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertTestDatabaseUrl } from "../support/test-db-guard.js";

// Two ways .env gets loaded in this repo:
//  - the app's npm scripts pass `--env-file-if-exists=.env` to Node (see package.json);
//  - Vitest doesn't take that flag, so test code loads it here with process.loadEnvFile.
// Either way, variables already set in the environment (e.g. by CI) win over the file.
if (existsSync(".env")) process.loadEnvFile(".env");

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start Postgres with `docker compose up -d` and copy .env.example to .env.",
    );
  }
  // Safety net: these tests create and drop schemas, so refuse anything that isn't a test database.
  assertTestDatabaseUrl(url);
  return url;
}

export interface TestDb {
  client: pg.Client;
  schema: string;
  /** Drops the schema and closes the connection. */
  cleanup: () => Promise<void>;
}

/** Opens a connection whose search_path is a fresh, empty schema. */
export async function openTestDb(): Promise<TestDb> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  // Belt and braces: check the database we actually landed in, not just what the URL says.
  const current = await client.query<{ name: string }>("SELECT current_database() AS name");
  if (!current.rows[0]?.name.endsWith("_test")) {
    await client.end();
    throw new Error(`Connected to "${current.rows[0]?.name}", which is not a _test database. Stopping.`);
  }
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  // search_path is like a default namespace: unqualified table names now resolve to this schema.
  await client.query(`SET search_path TO ${schema}`);

  return {
    client,
    schema,
    cleanup: async () => {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    },
  };
}

/** Table names in the current schema, sorted. */
export async function listTables(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

/**
 * Opens ANOTHER connection to an existing test schema (from openTestDb). Used to act as a second
 * user at the same time, e.g. to hold a transaction open while the code under test runs.
 * The caller closes it with `await client.end()`; the schema is still dropped by openTestDb's cleanup.
 */
export async function openExtraConnection(schema: string): Promise<pg.Client> {
  // `options: "-c search_path=..."` sets search_path when the connection opens, like SET search_path.
  const client = new pg.Client({ connectionString: testDatabaseUrl(), options: `-c search_path=${schema}` });
  await client.connect();
  return client;
}
