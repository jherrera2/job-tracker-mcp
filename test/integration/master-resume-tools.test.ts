// set_master_resume / get_master_resume (PRD 01 §2 story 1, §3), called the way a chat app calls
// them: through a real MCP client, against a real Postgres (never mocked). Each test gets its own
// fresh schema from db-helpers, with the real migrations applied.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import type { Queryable } from "../../src/db/database.js";
import { createServer } from "../../src/server.js";
import { openExtraConnection, openTestDb, testDatabaseUrl, type TestDb } from "./db-helpers.js";

// The shape of a tool result we read in these tests (the SDK's own type is a wide union).
interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

// Two different, valid résumés (both over the 200-character minimum).
const RESUME_V1 = `# Jane Doe
Senior Software Engineer

## Experience
- Led a team of 4 to rebuild the billing service in C#, cutting failed payments by 30%.
- Introduced CI/CD with automated tests, taking releases from monthly to weekly.
`;
const RESUME_V2 = `${RESUME_V1}- Mentored 3 junior developers, two of whom were promoted within a year.\n`;

describe("master résumé tools", () => {
  let db: TestDb;
  let client: Client;

  // Fresh schema + migrations + a server wired to it, per test. Teardown (the returned function)
  // closes the MCP client and server first, then drops the schema.
  beforeEach(async () => {
    const opened = await openTestDb();
    db = opened;
    await migrate(opened.client);
    const connected = await connect(opened.client);
    client = connected.client;
    return async () => {
      await connected.close();
      await opened.cleanup();
    };
  });

  async function connect(database: Queryable, databaseUrl = testDatabaseUrl()) {
    const server = createServer({ db: database, databaseUrl });
    const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    return {
      client: mcpClient,
      close: async () => {
        await mcpClient.close();
        await server.close();
      },
    };
  }

  async function call(name: string, args: Record<string, unknown>, on: Client = client): Promise<ToolResult> {
    return (await on.callTool({ name, arguments: args })) as ToolResult;
  }

  /** Calls a tool that must succeed; returns its structured result. */
  async function callOk(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await call(name, args);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result.structuredContent ?? {};
  }

  /** Calls a tool that must fail; returns the message the user would see. */
  async function callError(name: string, args: Record<string, unknown>, on: Client = client): Promise<string> {
    const result = await call(name, args, on);
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? "";
  }

  async function savedRows(): Promise<{ version: number; text: string }[]> {
    const rows = await db.client.query<{ version: number; text: string }>(
      "SELECT version, text FROM master_resume_versions ORDER BY version",
    );
    return rows.rows;
  }

  describe("set_master_resume", () => {
    it("saves the first résumé as version 1 and returns its length", async () => {
      const result = await callOk("set_master_resume", { text: RESUME_V1 });

      expect(result).toEqual({ version: 1, chars: [...RESUME_V1].length });
      expect(await savedRows()).toEqual([{ version: 1, text: RESUME_V1 }]);
    });

    it("also returns the result as JSON text, for chat apps that ignore structured results", async () => {
      const result = await call("set_master_resume", { text: RESUME_V1 });
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ version: 1, chars: [...RESUME_V1].length });
    });

    it("adds a new version on every save and never overwrites an old one", async () => {
      await callOk("set_master_resume", { text: RESUME_V1 });
      const second = await callOk("set_master_resume", { text: RESUME_V2 });
      const third = await callOk("set_master_resume", { text: RESUME_V1 }); // same text again is still a new version

      expect(second.version).toBe(2);
      expect(third.version).toBe(3);
      expect(await savedRows()).toEqual([
        { version: 1, text: RESUME_V1 },
        { version: 2, text: RESUME_V2 },
        { version: 3, text: RESUME_V1 },
      ]);
    });

    it("stores the text exactly as sent (spaces, Windows line breaks, emoji)", async () => {
      const text = `  \r\n${RESUME_V1.replaceAll("\n", "\r\n")}  ⭐ Award: Dev of the year 😀\n\n`;
      const result = await callOk("set_master_resume", { text });

      expect(result.chars).toBe([...text].length);
      expect(await savedRows()).toEqual([{ version: 1, text }]);
    });

    it("rejects a résumé under 200 characters with a clear sentence and saves nothing", async () => {
      const message = await callError("set_master_resume", { text: "Jane Doe, engineer." });

      expect(message).toBe("Your résumé is 19 characters; it needs at least 200. Paste the whole résumé.");
      expect(await savedRows()).toEqual([]);
    });

    it("rejects a résumé over 60,000 characters with a clear sentence and saves nothing", async () => {
      const message = await callError("set_master_resume", { text: "x".repeat(60_001) });

      expect(message).toBe(
        "Your résumé is 60,001 characters; the limit is 60,000. Remove anything that isn't part of the résumé.",
      );
      expect(await savedRows()).toEqual([]);
    });

    it("accepts exactly 200 and exactly 60,000 characters", async () => {
      expect(await callOk("set_master_resume", { text: "a".repeat(200) })).toEqual({ version: 1, chars: 200 });
      expect(await callOk("set_master_resume", { text: "a".repeat(60_000) })).toEqual({ version: 2, chars: 60_000 });
    });

    it("rejects a file's raw contents (binary / control characters) and saves nothing", async () => {
      const message = await callError("set_master_resume", { text: `%PDF-1.7\u0000\u0001${RESUME_V1}` });

      expect(message).toBe("That looks like a file's raw contents, not text. Paste the résumé as plain text or Markdown.");
      expect(await savedRows()).toEqual([]);
    });

    it("rejects C1 control characters (U+0080–U+009F, from a wrongly decoded file) and saves nothing", async () => {
      const message = await callError("set_master_resume", { text: `${RESUME_V1}\u009B31m\u0085` });

      expect(message).toBe("That looks like a file's raw contents, not text. Paste the résumé as plain text or Markdown.");
      expect(await savedRows()).toEqual([]);
    });

    it("rejects broken text (a lone half of an emoji) and saves nothing", async () => {
      const message = await callError("set_master_resume", { text: `${RESUME_V1}\uD83D` });

      expect(message).toBe("That looks like a file's raw contents, not text. Paste the résumé as plain text or Markdown.");
      expect(await savedRows()).toEqual([]);
    });

    // Wrong TYPE (no text, a number, null) is rejected by the SDK before our code runs, using the
    // published inputSchema, so the user sees the SDK's own wording. Accepted trade-off: see the
    // comment at the top of src/tools/master-resume-tools.ts.
    it.each([
      ["no text", {}],
      ["a number", { text: 12345 }],
      ["null", { text: null }],
    ])("rejects %s with the SDK's type error and saves nothing", async (_name, args) => {
      const message = await callError("set_master_resume", args);

      expect(message).toContain("Input validation error");
      expect(message).toContain("expected string");
      expect(await savedRows()).toEqual([]);
    });

    it("a save that collides with another save at the same moment retries and gets the next version", async () => {
      // Make the race happen on purpose instead of hoping for it:
      // 1. A second connection inserts version 1 inside a transaction and does NOT commit yet.
      // 2. The tool runs. It can't see the uncommitted row, so it also picks version 1, and
      //    Postgres makes it wait on the UNIQUE index to see whether the other row commits.
      // 3. We commit. The tool's insert now fails with a unique violation, and the tool must retry
      //    and save as version 2 instead of showing the user a database error.
      const other = await openExtraConnection(db.schema);
      try {
        // Read the server connection's process id now: once the save starts, that connection is busy waiting.
        const serverPid = await backendPid(db.client);
        await other.query("BEGIN");
        await other.query("INSERT INTO master_resume_versions (version, text) VALUES (1, $1)", [RESUME_V1]);

        const saving = call("set_master_resume", { text: RESUME_V2 });
        await waitUntilBlockedBy(serverPid, other);
        await other.query("COMMIT");
        const result = await saving;

        expect(result.isError, result.content[0]?.text).toBeFalsy();
        expect(result.structuredContent).toEqual({ version: 2, chars: [...RESUME_V2].length });
        expect(await savedRows()).toEqual([
          { version: 1, text: RESUME_V1 },
          { version: 2, text: RESUME_V2 },
        ]);
      } finally {
        await other.end();
      }
    });

    it("several saves at the same time all succeed with versions 1, 2, 3 (no gaps, no duplicates)", async () => {
      // A pool gives the server several connections, so the saves really run in parallel.
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 3 });
      const parallel = await connect(pool);
      try {
        const results = await Promise.all(
          ["first", "second", "third"].map((label) =>
            call("set_master_resume", { text: `${label}: ${RESUME_V1}` }, parallel.client),
          ),
        );

        for (const result of results) expect(result.isError, result.content[0]?.text).toBeFalsy();
        const versions = results.map((result) => result.structuredContent?.version as number).sort((a, b) => a - b);
        expect(versions).toEqual([1, 2, 3]);
        expect((await savedRows()).map((row) => row.version)).toEqual([1, 2, 3]);
      } finally {
        await parallel.close();
        await pool.end();
      }
    });
  });

  describe("get_master_resume", () => {
    it("explains that nothing is saved yet", async () => {
      const message = await callError("get_master_resume", {});
      expect(message).toBe("No master résumé is saved yet. Save one with set_master_resume.");
    });

    it("returns the latest version by default", async () => {
      await callOk("set_master_resume", { text: RESUME_V1 });
      await callOk("set_master_resume", { text: RESUME_V2 });

      const result = await callOk("get_master_resume", {});

      expect(result).toMatchObject({ version: 2, text: RESUME_V2 });
    });

    it("returns saved_at as an ISO timestamp from the database", async () => {
      await callOk("set_master_resume", { text: RESUME_V1 });
      const row = await db.client.query<{ created_at: Date }>("SELECT created_at FROM master_resume_versions");

      const result = await callOk("get_master_resume", {});

      expect(result.saved_at).toBe(row.rows[0]?.created_at.toISOString());
    });

    it("returns an older version when asked, unchanged", async () => {
      await callOk("set_master_resume", { text: RESUME_V1 });
      await callOk("set_master_resume", { text: RESUME_V2 });

      const result = await callOk("get_master_resume", { version: 1 });

      expect(result).toMatchObject({ version: 1, text: RESUME_V1 });
    });

    it("explains when the version asked for doesn't exist, naming the latest", async () => {
      await callOk("set_master_resume", { text: RESUME_V1 });
      await callOk("set_master_resume", { text: RESUME_V2 });

      const message = await callError("get_master_resume", { version: 5 });

      expect(message).toBe("There is no version 5. The latest is version 2.");
    });

    it("explains when a version is asked for but nothing is saved yet", async () => {
      const message = await callError("get_master_resume", { version: 1 });
      expect(message).toBe("No master résumé is saved yet. Save one with set_master_resume.");
    });

    it("rejects a version too big for the database with the same sentence (not a Postgres error)", async () => {
      const message = await callError("get_master_resume", { version: 2_147_483_648 });
      expect(message).toBe("Version must be a whole number, 1 or higher.");
    });

    it("looks up the largest allowed version without a database error", async () => {
      await callOk("set_master_resume", { text: RESUME_V1 });
      const message = await callError("get_master_resume", { version: 2_147_483_647 });
      expect(message).toBe("There is no version 2147483647. The latest is version 1.");
    });

    it("rejects a version sent as text with the SDK's type error", async () => {
      const message = await callError("get_master_resume", { version: "2" });
      expect(message).toContain("Input validation error");
      expect(message).toContain("expected number");
    });

    it.each([0, -3, 1.5])("rejects version %s with a clear sentence", async (version) => {
      const message = await callError("get_master_resume", { version });
      expect(message).toBe("Version must be a whole number, 1 or higher.");
    });
  });

  describe("when the database is down", () => {
    it("answers with a sentence naming host and port, never the password", async () => {
      // A real pool pointed at a port nothing listens on (not a mock: pg really tries to connect).
      const downUrl = "postgres://jobsearch:s3cret-pw@127.0.0.1:1/jobsearch_test";
      const pool = new pg.Pool({ connectionString: downUrl });
      const down = await connect(pool, downUrl);
      try {
        for (const [name, args] of [
          ["set_master_resume", { text: RESUME_V1 }],
          ["get_master_resume", {}],
        ] as const) {
          const message = await callError(name, args, down.client);
          expect(message).toContain("Can't reach Postgres at 127.0.0.1:1");
          expect(message).not.toContain("s3cret-pw");
        }
      } finally {
        await down.close();
        await pool.end();
      }
    });
  });
});

/** Waits (up to 5 s) until the connection with process id `waiterPid` is blocked by a lock `holder` holds. */
async function waitUntilBlockedBy(waiterPid: number, holder: pg.Client): Promise<void> {
  const holderPid = await backendPid(holder);
  for (let attempt = 0; attempt < 100; attempt++) {
    // Ask from the holder's connection, since the waiter's connection is busy.
    // pg_blocking_pids(pid) lists the connections that pid is waiting for.
    const blocked = await holder.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY (pg_blocking_pids($1)) AS blocked",
      [waiterPid, holderPid],
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The save never waited on the other connection's uncommitted row.");
}

/** The id of the Postgres process serving this connection (pg_backend_pid()). */
async function backendPid(connection: pg.Client): Promise<number> {
  const result = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]?.pid ?? -1;
}
