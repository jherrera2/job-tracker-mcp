// get_prompt / update_prompt / reset_prompt (PRD 01 §2 story 6, §3), called the way a chat app calls
// them: through a real MCP client, against a real Postgres (never mocked). Each test gets its own
// fresh schema from db-helpers, with the real migrations applied.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { FIT_CHECK_DEFAULT_PROMPT } from "../../src/domain/prompts.js";
import { createServer } from "../../src/server.js";
import { openExtraConnection, openTestDb, testDatabaseUrl, type TestDb } from "./db-helpers.js";

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

interface PromptRow {
  name: string;
  version: number;
  text: string;
  is_default: boolean;
}

const EDITED = "You are a blunt reviewer. Judge the fit strictly.\n\nAnswer in the required JSON shape.";
const EDITED_AGAIN = `${EDITED}\nTreat 'nice to have' items as optional.`;
const UNKNOWN_NAME = "There is no prompt with that name. The prompts you can edit are: fit_check.";

describe("prompt tools", () => {
  let db: TestDb;
  let client: Client;

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

  async function connect(database: Queryable) {
    const server = createServer({ db: database, databaseUrl: testDatabaseUrl() });
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

  async function callOk(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await call(name, args);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result.structuredContent ?? {};
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? "";
  }

  async function savedRows(): Promise<PromptRow[]> {
    const rows = await db.client.query<PromptRow>("SELECT name, version, text, is_default FROM prompts ORDER BY name, version");
    return rows.rows;
  }

  const defaultRow = (version: number): PromptRow => ({
    name: "fit_check",
    version,
    text: FIT_CHECK_DEFAULT_PROMPT,
    is_default: true,
  });

  describe("get_prompt", () => {
    it("returns the shipped default as version 1 the first time, and stores exactly that text", async () => {
      const result = await callOk("get_prompt", { name: "fit_check" });

      expect(result).toMatchObject({ name: "fit_check", version: 1, text: FIT_CHECK_DEFAULT_PROMPT, is_default: true });
      // The stored default equals the one constant in src/domain/prompts.ts, byte for byte.
      expect(await savedRows()).toEqual([defaultRow(1)]);
    });

    it("does not add a row when read again", async () => {
      await callOk("get_prompt", { name: "fit_check" });
      await callOk("get_prompt", { name: "fit_check" });
      expect(await savedRows()).toEqual([defaultRow(1)]);
    });

    it("returns saved_at as an ISO timestamp from the database", async () => {
      const result = await callOk("get_prompt", { name: "fit_check" });
      const row = await db.client.query<{ created_at: Date }>("SELECT created_at FROM prompts");
      expect(result.saved_at).toBe(row.rows[0]?.created_at.toISOString());
    });

    it("also returns the result as JSON text, for chat apps that ignore structured results", async () => {
      const result = await call("get_prompt", { name: "fit_check" });
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
    });

    it("returns the latest edit", async () => {
      await callOk("update_prompt", { name: "fit_check", text: EDITED });
      await callOk("update_prompt", { name: "fit_check", text: EDITED_AGAIN });

      const result = await callOk("get_prompt", { name: "fit_check" });
      expect(result).toMatchObject({ version: 3, text: EDITED_AGAIN, is_default: false });
    });

    it("forgives capital letters and spaces around the name", async () => {
      const result = await callOk("get_prompt", { name: "  FIT_CHECK " });
      expect(result).toMatchObject({ name: "fit_check", version: 1 });
    });

    it("rejects an unknown name with a short sentence and writes nothing", async () => {
      expect(await callError("get_prompt", { name: "interview_prep" })).toBe(UNKNOWN_NAME);
      expect(await savedRows()).toEqual([]);
    });
  });

  describe("update_prompt", () => {
    it("keeps the shipped default as version 1 and saves the edit as version 2", async () => {
      const result = await callOk("update_prompt", { name: "fit_check", text: EDITED });

      expect(result).toMatchObject({ name: "fit_check", version: 2, text: EDITED, is_default: false });
      expect(await savedRows()).toEqual([defaultRow(1), { name: "fit_check", version: 2, text: EDITED, is_default: false }]);
    });

    it("adds a new version on every edit and never overwrites an old one", async () => {
      await callOk("update_prompt", { name: "fit_check", text: EDITED });
      await callOk("update_prompt", { name: "fit_check", text: EDITED_AGAIN });
      const third = await callOk("update_prompt", { name: "fit_check", text: EDITED }); // same text again is still a new version

      expect(third.version).toBe(4);
      expect((await savedRows()).map((row) => [row.version, row.text])).toEqual([
        [1, FIT_CHECK_DEFAULT_PROMPT],
        [2, EDITED],
        [3, EDITED_AGAIN],
        [4, EDITED],
      ]);
    });

    it("an edit that happens to match the default is still an edit (is_default false)", async () => {
      const result = await callOk("update_prompt", { name: "fit_check", text: FIT_CHECK_DEFAULT_PROMPT });
      expect(result).toMatchObject({ version: 2, is_default: false });
    });

    it("stores the text exactly as sent (spaces, Windows line breaks, emoji)", async () => {
      const text = `  \r\n${EDITED.replaceAll("\n", "\r\n")}  ⭐ 😀\n\n`;
      const result = await callOk("update_prompt", { name: "fit_check", text });

      expect(result.text).toBe(text);
      expect((await savedRows())[1]?.text).toBe(text);
    });

    it("accepts exactly 20,000 characters", async () => {
      const result = await callOk("update_prompt", { name: "fit_check", text: "a".repeat(20_000) });
      expect(result.version).toBe(2);
    });

    it.each([
      ["over 20,000 characters", "a".repeat(20_001), "The prompt is 20,001 characters; the limit is 20,000. Shorten it and try again."],
      ["empty", "   \n ", "The prompt is empty. Write the instructions, or use reset_prompt to go back to the default."],
      ["raw file bytes", `%PDF\u0000${EDITED}`, "That looks like a file's raw contents, not text. Send the prompt as plain text."],
    ])("rejects text that is %s and saves nothing", async (_label, text, message) => {
      expect(await callError("update_prompt", { name: "fit_check", text })).toBe(message);
      expect(await savedRows()).toEqual([]);
    });

    it("rejects an unknown name with a short sentence and saves nothing", async () => {
      expect(await callError("update_prompt", { name: "cover_letter", text: EDITED })).toBe(UNKNOWN_NAME);
      expect(await savedRows()).toEqual([]);
    });

    it("checks the name before the text, so a bad name gets the name sentence", async () => {
      expect(await callError("update_prompt", { name: "nope", text: "" })).toBe(UNKNOWN_NAME);
    });

    it("an edit that collides with another save at the same moment retries and gets the next version", async () => {
      // Same forced race as the master résumé test: a second connection holds an uncommitted
      // version 2; the tool also picks 2, waits on the UNIQUE index, collides when we commit,
      // and must retry as version 3 instead of showing a database error.
      await callOk("get_prompt", { name: "fit_check" }); // version 1 (the default) exists
      const other = await openExtraConnection(db.schema);
      try {
        const serverPid = await backendPid(db.client);
        await other.query("BEGIN");
        await other.query("INSERT INTO prompts (name, version, text) VALUES ('fit_check', 2, $1)", [EDITED]);

        const saving = call("update_prompt", { name: "fit_check", text: EDITED_AGAIN });
        await waitUntilBlockedBy(serverPid, other);
        await other.query("COMMIT");
        const result = await saving;

        expect(result.isError, result.content[0]?.text).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ version: 3, text: EDITED_AGAIN });
        expect((await savedRows()).map((row) => [row.version, row.text])).toEqual([
          [1, FIT_CHECK_DEFAULT_PROMPT],
          [2, EDITED],
          [3, EDITED_AGAIN],
        ]);
      } finally {
        await other.end();
      }
    });

    it("several edits at once on a fresh database: one default row, then 2, 3, 4 (no gaps, no duplicates)", async () => {
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 3 });
      const parallel = await connect(pool);
      try {
        const results = await Promise.all(
          ["first", "second", "third"].map((label) =>
            call("update_prompt", { name: "fit_check", text: `${label}: ${EDITED}` }, parallel.client),
          ),
        );

        for (const result of results) expect(result.isError, result.content[0]?.text).toBeFalsy();
        const versions = results.map((result) => result.structuredContent?.version as number).sort((a, b) => a - b);
        expect(versions).toEqual([2, 3, 4]);
        const rows = await savedRows();
        expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4]);
        expect(rows[0]).toEqual(defaultRow(1));
      } finally {
        await parallel.close();
        await pool.end();
      }
    });

    it("several first reads at once store the default only once", async () => {
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 3 });
      const parallel = await connect(pool);
      try {
        const results = await Promise.all([1, 2, 3].map(() => call("get_prompt", { name: "fit_check" }, parallel.client)));
        for (const result of results) expect(result.structuredContent).toMatchObject({ version: 1, is_default: true });
        expect(await savedRows()).toEqual([defaultRow(1)]);
      } finally {
        await parallel.close();
        await pool.end();
      }
    });
  });

  describe("reset_prompt", () => {
    it("saves the shipped default as a new version after an edit, keeping the edit", async () => {
      await callOk("update_prompt", { name: "fit_check", text: EDITED });

      const result = await callOk("reset_prompt", { name: "fit_check" });

      expect(result).toMatchObject({ name: "fit_check", version: 3, text: FIT_CHECK_DEFAULT_PROMPT, is_default: true });
      expect(await savedRows()).toEqual([defaultRow(1), { name: "fit_check", version: 2, text: EDITED, is_default: false }, defaultRow(3)]);
      expect(await callOk("get_prompt", { name: "fit_check" })).toMatchObject({ version: 3, is_default: true });
    });

    it("on a fresh database returns version 1 (the default) without adding another row", async () => {
      const result = await callOk("reset_prompt", { name: "fit_check" });
      expect(result).toMatchObject({ version: 1, is_default: true });
      expect(await savedRows()).toEqual([defaultRow(1)]);
    });

    it("does nothing when the latest version already is the shipped default", async () => {
      await callOk("update_prompt", { name: "fit_check", text: EDITED });
      await callOk("reset_prompt", { name: "fit_check" });
      const again = await callOk("reset_prompt", { name: "fit_check" });

      expect(again).toMatchObject({ version: 3, is_default: true });
      expect((await savedRows()).map((row) => row.version)).toEqual([1, 2, 3]);
    });

    it("several resets at once after an edit add exactly ONE default row (tester M1)", async () => {
      await callOk("update_prompt", { name: "fit_check", text: EDITED });
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 5 });
      const parallel = await connect(pool);
      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, () => call("reset_prompt", { name: "fit_check" }, parallel.client)),
        );

        for (const result of results) {
          expect(result.isError, result.content[0]?.text).toBeFalsy();
          expect(result.structuredContent).toMatchObject({ version: 3, text: FIT_CHECK_DEFAULT_PROMPT, is_default: true });
        }
        expect(await savedRows()).toEqual([defaultRow(1), { name: "fit_check", version: 2, text: EDITED, is_default: false }, defaultRow(3)]);
      } finally {
        await parallel.close();
        await pool.end();
      }
    });

    it("a reset racing an edit still ends on the default (the edit is kept, the default lands after it)", async () => {
      await callOk("get_prompt", { name: "fit_check" });
      await callOk("update_prompt", { name: "fit_check", text: EDITED });
      // Another connection holds an uncommitted edit as version 3; the reset also picks 3, waits,
      // collides when we commit, and must re-check: the latest is now an edit, so it adds version 4.
      const other = await openExtraConnection(db.schema);
      try {
        const serverPid = await backendPid(db.client);
        await other.query("BEGIN");
        await other.query("INSERT INTO prompts (name, version, text) VALUES ('fit_check', 3, $1)", [EDITED_AGAIN]);

        const resetting = call("reset_prompt", { name: "fit_check" });
        await waitUntilBlockedBy(serverPid, other);
        await other.query("COMMIT");
        const result = await resetting;

        expect(result.isError, result.content[0]?.text).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ version: 4, is_default: true });
        expect((await savedRows()).map((row) => [row.version, row.is_default])).toEqual([
          [1, true],
          [2, false],
          [3, false],
          [4, true],
        ]);
      } finally {
        await other.end();
      }
    });

    it("restores the CURRENT shipped default when an older default row has different text", async () => {
      // Simulates an upgrade that changed the shipped default (step 6 will refine the wording):
      // the stored version 1 holds last release's default.
      await db.client.query("INSERT INTO prompts (name, version, text, is_default) VALUES ('fit_check', 1, 'old default', true)");

      const result = await callOk("reset_prompt", { name: "fit_check" });

      expect(result).toMatchObject({ version: 2, text: FIT_CHECK_DEFAULT_PROMPT, is_default: true });
    });

    it("rejects an unknown name with a short sentence and writes nothing", async () => {
      expect(await callError("reset_prompt", { name: "" })).toBe(UNKNOWN_NAME);
      expect(await savedRows()).toEqual([]);
    });
  });

  it("keeps each prompt name's versions separate (another name's rows don't move fit_check's numbers)", async () => {
    // Only fit_check ships in v1; a row for another name stands in for a later iteration's prompt.
    await db.client.query("INSERT INTO prompts (name, version, text) VALUES ('interview_prep', 1, 'x'), ('interview_prep', 2, 'y')");

    const result = await callOk("update_prompt", { name: "fit_check", text: EDITED });

    expect(result.version).toBe(2);
  });
});

/** Waits until `waiterPid`'s query is blocked by the connection `holder` (polls pg_blocking_pids). */
async function waitUntilBlockedBy(waiterPid: number, holder: pg.Client): Promise<void> {
  const holderPid = await backendPid(holder);
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = await holder.query<{ blocked: boolean }>("SELECT $2::int = ANY (pg_blocking_pids($1)) AS blocked", [
      waiterPid,
      holderPid,
    ]);
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The save never waited on the other connection's uncommitted row.");
}

async function backendPid(connection: pg.Client): Promise<number> {
  const result = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]?.pid ?? -1;
}
