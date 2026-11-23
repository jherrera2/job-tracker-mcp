// Ctrl-C / SIGTERM with a REAL child process and REAL signals (step 8 re-check M3): the eval
// schema must be gone after the process exits, whether the signal lands during migrate, during a
// tool call that has a transaction open, or during close. Each moment is held still with a lock
// this test owns, so the signal lands exactly there. Only this run's own schema is checked.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { newEvalSchemaName } from "../../evals/src/harness.js";
import { testDatabaseUrl } from "./db-helpers.js";

const MIGRATE_LOCK = "job-tracker-mcp:migrate"; // src/db/migrate.ts
const TSX = new URL("../../node_modules/.bin/tsx", import.meta.url).pathname;
const CHILD = new URL("../support/evals-signal-child.ts", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface Child {
  process: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function startChild(repeats: number, schema: string): Child {
  // Only what the child needs: no ANTHROPIC_API_KEY from this shell or .env reaches it.
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TEST_DATABASE_URL: testDatabaseUrl() };
  const child = spawn(TSX, [CHILD, String(repeats), schema, mkdtempSync(join(tmpdir(), "evals-sig-"))], { env, stdio: "pipe" });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { process: child, output: () => output, exited };
}

let db: pg.Client;
let child: Child | undefined;

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  return client;
}

const schemaExists = async (schema: string) =>
  (await db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema])).rowCount === 1;

/** True while some backend waits on a lock in a query starting with `prefix`. */
const waitingOn = async (prefix: string) =>
  ((
    await db.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE $1",
      [`${prefix}%`],
    )
  ).rowCount ?? 0) > 0;

afterEach(async () => {
  child?.process.kill("SIGKILL");
  child = undefined;
  await db?.end().catch(() => undefined);
});

describe("evals: a real SIGINT / SIGTERM leaves no schema behind", () => {
  it("during migrate (SIGINT → exit 130)", async () => {
    db = await connect();
    const holder = await connect();
    const schema = newEvalSchemaName();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATE_LOCK]);
      child = startChild(1, schema);
      await waitFor("the schema and a migrate waiting on its lock", async () => (await schemaExists(schema)) && (await waitingOn("SELECT pg_advisory_lock")));
      child.process.kill("SIGINT");
      await sleep(300);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATE_LOCK]);
      await holder.end();
    }
    expect(await child.exited, child.output()).toBe(130);
    expect(await schemaExists(schema)).toBe(false);
  });

  it("during a tool call with its transaction open (SIGTERM → exit 143)", async () => {
    db = await connect();
    const holder = await connect();
    const schema = newEvalSchemaName();
    child = startChild(2, schema);
    await waitFor("READY", () => Promise.resolve(child?.output().includes("READY") ?? false));
    try {
      // SHARE lets run 1 finish (save_fit, get_job) but stops run 2's add_job INSERT inside its transaction.
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${schema}.jobs IN SHARE MODE`);
      child.process.stdin?.write("go\n");
      await waitFor("add_job's INSERT waiting inside its transaction", () => waitingOn("INSERT INTO jobs"));
      child.process.kill("SIGTERM");
      await sleep(300);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(await child.exited, child.output()).toBe(143);
    expect(await schemaExists(schema)).toBe(false);
  });

  it("during close, while DROP SCHEMA waits (SIGINT → exit 130)", async () => {
    db = await connect();
    const holder = await connect();
    const schema = newEvalSchemaName();
    child = startChild(1, schema);
    await waitFor("READY", () => Promise.resolve(child?.output().includes("READY") ?? false));
    try {
      // A plain read keeps an ACCESS SHARE lock until ROLLBACK: the run finishes, its DROP waits.
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${schema}.jobs LIMIT 1`);
      child.process.stdin?.write("go\n");
      await waitFor("close's DROP SCHEMA waiting", () => waitingOn("DROP SCHEMA"));
      child.process.kill("SIGINT");
      await sleep(300);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(await child.exited, child.output()).toBe(130);
    expect(await schemaExists(schema)).toBe(false);
  });
});
