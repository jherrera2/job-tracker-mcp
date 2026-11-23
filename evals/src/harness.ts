// The real MCP server, in this process, against a THROWAWAY schema in a _test database.
//
// Every case goes through the same tools a chat app would call: add_job, get_fit_inputs, save_fit
// and get_job, over an in-memory MCP connection. Nothing is mocked except the network: HTML cases
// are served from a stand-in fetch as recorded Greenhouse answers, so they still go through the
// step-4 adapter and htmlToText.
//
// Database: EVAL_DATABASE_URL if set, otherwise TEST_DATABASE_URL. Its name must end in "_test"
// (the integration tests' guard). The schema is "eval_" + a random id (newEvalSchemaName, made by
// the CALLER so a Ctrl-C handler knows it before the schema exists), so it can't collide with the
// integration tests' "t_…" schemas or with another run. It is dropped in close(), or by
// dropEvalSchema on a fresh connection when the run is interrupted.
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";
import { createServer } from "../../src/server.js";
import type { FetchFn } from "../../src/sources/safe-fetch.js";
import { detectJobSource } from "../../src/sources/job-url.js";
import { assertTestDatabaseUrl } from "../../test/support/test-db-guard.js";
import { assertConnectedToTestDb } from "./db-guard.js";
import { greenhouseApiJson, greenhouseJobUrl, type EvalCase } from "./dataset.js";

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** The tools offered to the model: the server's own definitions, as a chat app would pass them on. */
export const MODEL_TOOL_NAMES = ["get_fit_inputs", "save_fit"] as const;

export interface Harness {
  schema: string;
  /** get_fit_inputs and save_fit, with the server's real names, descriptions and input schemas. */
  tools: Anthropic.Tool[];
  /** Calls one MCP tool. */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Calls one MCP tool and throws with its message if it answers with an error. */
  callOk(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** add_job for a case (pasted text or its Greenhouse link); returns the job id. */
  addJob(evalCase: EvalCase, index: number): Promise<number>;
  /** Closes the MCP connection and drops the schema. Safe to call more than once (or at the same time). */
  close(): Promise<void>;
}

export interface HarnessOptions {
  databaseUrl: string;
  /** From newEvalSchemaName(). */
  schema: string;
  /** Told the harness connection's server process id as soon as it is open (for an interrupt). */
  onBackendPid?: (pid: number) => void;
  /** Checked just before the schema is created: an interrupt that came first means "don't". */
  cancelled?: () => boolean;
  resumeText: string;
  criteria: readonly { label: string; detail: string }[];
  cases: readonly EvalCase[];
}

/** A fetch that answers only the Greenhouse API URLs of the HTML cases; anything else is a 404. */
function greenhouseFetch(cases: readonly EvalCase[]): FetchFn {
  const routes = new Map<string, string>();
  cases.forEach((c, index) => {
    if (c.posting.source !== "greenhouse") return;
    const detected = detectJobSource(greenhouseJobUrl(index));
    if (!detected.ok) throw new Error(detected.message);
    routes.set(detected.source.apiUrl, JSON.stringify(greenhouseApiJson(c.posting)));
  });
  return (url) => {
    const body = routes.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

/**
 * MCP tool definitions → Anthropic tool definitions, keeping only get_fit_inputs and save_fit.
 * The JSON-Schema "$schema" key the MCP SDK adds is dropped: it is not part of a tool's input schema.
 */
export function toModelTools(
  tools: readonly { name: string; description?: string; inputSchema: Anthropic.Tool.InputSchema }[],
): Anthropic.Tool[] {
  return tools
    .filter((t) => (MODEL_TOOL_NAMES as readonly string[]).includes(t.name))
    .map((t) => {
      const inputSchema: Record<string, unknown> & Anthropic.Tool.InputSchema = { ...t.inputSchema };
      delete inputSchema.$schema;
      return { name: t.name, description: t.description ?? "", input_schema: inputSchema };
    });
}

const SCHEMA_NAME = /^eval_[0-9a-f]{32}$/;

/** The application_name of the harness's database connection. */
export const harnessConnectionName = (schema: string): string => `evals:${schema}`;

/** A fresh throwaway schema name: "eval_" + 32 hex characters. */
export function newEvalSchemaName(): string {
  return `eval_${randomUUID().replaceAll("-", "")}`;
}

function checkedSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Not an eval schema name: ${JSON.stringify(schema)}.`);
  return schema;
}

/**
 * Drops an eval schema on a FRESH connection (step 8 re-check M3). If the harness connection is
 * known (its pid AND application_name "evals:<schema>" AND this database), it is terminated first, so a tool transaction it holds open is rolled back and can't keep
 * the schema alive or make the DROP wait on it.
 */
export async function dropEvalSchema(
  databaseUrl: string,
  schema: string,
  harnessPid: () => number | undefined = () => undefined,
): Promise<void> {
  assertTestDatabaseUrl(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  client.on("error", () => undefined);
  await client.connect();
  try {
    assertConnectedToTestDb((await client.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name);
    const pid = harnessPid(); // read now, not when the handler started: it may have just become known
    // Only if that pid is still the harness's own connection: a pid can be reused, and the role
    // may be a superuser on the real database server, so the name and database must match too.
    if (pid !== undefined) {
      await client.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND application_name = $2 AND datname = current_database()",
        [pid, harnessConnectionName(schema)],
      );
    }
    await client.query(`DROP SCHEMA IF EXISTS ${checkedSchemaName(schema)} CASCADE`);
  } finally {
    await client.end();
  }
}

export { assertConnectedToTestDb };

export async function openHarness(options: HarnessOptions): Promise<Harness> {
  assertTestDatabaseUrl(options.databaseUrl);
  const schema = checkedSchemaName(options.schema);
  // The name lets dropEvalSchema make sure a pid it terminates is still THIS connection.
  const db = new pg.Client({ connectionString: options.databaseUrl, application_name: harnessConnectionName(schema) });
  // An interrupt terminates this connection from the outside; without a listener, pg's "error"
  // event would crash the process before the cleanup finishes.
  db.on("error", () => undefined);
  await db.connect();
  let mcp: Client | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  // One close, however many callers: the normal path, a failure while opening, and a Ctrl-C handler.
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await mcp?.close();
        await server?.close();
      } finally {
        try {
          await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await db.end();
        }
      }
    })());

  const call = async (name: string, args: Record<string, unknown>) => {
    if (!mcp) throw new Error("The MCP connection is not open.");
    return (await mcp.callTool({ name, arguments: args })) as ToolResult;
  };
  const callOk = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text ?? "no message"}`);
    return result.structuredContent ?? {};
  };

  let tools: Anthropic.Tool[];
  try {
    // Check the database we actually reached, not only what the URL says.
    const current = await db.query<{ name: string }>("SELECT current_database() AS name");
    assertConnectedToTestDb(current.rows[0]?.name);
    const pid = await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    if (pid.rows[0]) options.onBackendPid?.(pid.rows[0].pid);
    if (options.cancelled?.()) throw new Error("Interrupted before the eval schema was created.");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await migrate(db);

    server = createServer({ db, databaseUrl: options.databaseUrl, fetch: greenhouseFetch(options.cases) });
    mcp = new Client({ name: "evals", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await mcp.connect(clientSide);

    tools = toModelTools((await mcp.listTools()).tools);
    // Inside the try (review R1): a refused résumé or criteria must still drop the schema.
    await callOk("set_master_resume", { text: options.resumeText });
    await callOk("set_criteria", { criteria: options.criteria });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    schema,
    tools,
    call,
    callOk,
    async addJob(evalCase, index) {
      const p = evalCase.posting;
      const args = p.source === "paste" ? { text: p.text, title: p.title, company: p.company } : { url: greenhouseJobUrl(index) };
      const added = await callOk("add_job", args);
      return (added.job as { id: number }).id;
    },
    close,
  };
}

/**
 * The tool definitions the model is offered, read from the server WITHOUT a database (tools/list
 * never queries it). main.ts uses this to size the request for the cost estimate before anything
 * is opened or sent.
 */
export async function listModelTools(): Promise<Anthropic.Tool[]> {
  const noDatabase = { query: () => Promise.reject(new Error("No database while listing tools.")) };
  const server = createServer({ db: noDatabase, databaseUrl: "postgres://localhost/none" });
  const client = new Client({ name: "evals-tools", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    return toModelTools((await client.listTools()).tools);
  } finally {
    await client.close();
    await server.close();
  }
}
