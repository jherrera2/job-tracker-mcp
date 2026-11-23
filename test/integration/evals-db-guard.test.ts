// main → openHarness really runs assertConnectedToTestDb on the database it reached (step 8
// re-check, Low). The guard module is wrapped in a spy; its real behaviour stays.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertConnectedToTestDb } from "../../evals/src/db-guard.js";
import { CRITERIA } from "../../evals/dataset/cases.js";
import { readMasterResume } from "../../evals/src/dataset.js";
import { newEvalSchemaName, openHarness } from "../../evals/src/harness.js";
import { runEvals } from "../../evals/src/main.js";
import { testDatabaseUrl } from "./db-helpers.js";

vi.mock("../../evals/src/db-guard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../evals/src/db-guard.js")>();
  return { ...real, assertConnectedToTestDb: vi.fn(real.assertConnectedToTestDb) };
});

const guard = vi.mocked(assertConnectedToTestDb);
const dbName = new URL(testDatabaseUrl()).pathname.slice(1);

async function schemaExists(schema: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema])).rowCount === 1;
  } finally {
    await client.end();
  }
}

const run = (schema: string) =>
  runEvals(["--dry-run", "--cases", "java-onsite", "--out", mkdtempSync(join(tmpdir(), "evals-guard-"))], {
    env: { TEST_DATABASE_URL: testDatabaseUrl() },
    out: () => undefined,
    err: () => undefined,
    createProvider: vi.fn(),
    newSchemaName: () => schema,
  });

describe("the connected-database check", () => {
  it("is called with the name of the database actually reached", async () => {
    guard.mockClear();
    expect(await run(newEvalSchemaName())).toBe(0);
    expect(guard).toHaveBeenCalledWith(dbName);
  });

  it("stops the run before any schema is created when it refuses", async () => {
    guard.mockImplementationOnce(() => {
      throw new Error("Connected to a database that is not a _test database. Stopping.");
    });
    const schema = newEvalSchemaName();
    expect(await run(schema)).toBe(1);
    expect(await schemaExists(schema)).toBe(false);
  });

  it("openHarness itself runs the check on the database it reached", async () => {
    guard.mockClear();
    const harness = await openHarness({
      databaseUrl: testDatabaseUrl(),
      schema: newEvalSchemaName(),
      resumeText: readMasterResume(),
      criteria: CRITERIA,
      cases: [],
    });
    await harness.close();
    expect(guard).toHaveBeenCalledWith(dbName);
  });
});
