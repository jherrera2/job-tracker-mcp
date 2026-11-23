// list_criteria_suggestions / set_criteria / get_criteria (PRD 01 §2 story 2, §3), called the way a
// chat app calls them: through a real MCP client, against a real Postgres (never mocked). Each test
// gets its own fresh schema from db-helpers, with the real migrations applied.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import type { Queryable } from "../../src/db/database.js";
import { CRITERIA_SUGGESTIONS } from "../../src/domain/criteria.js";
import { createServer } from "../../src/server.js";
import { openTestDb, testDatabaseUrl, type TestDb } from "./db-helpers.js";

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

interface Row {
  position: number;
  label: string;
  detail: string;
}

const PAY = { label: "Pay floor", detail: "Base pay of at least $140k." };
const REMOTE = { label: "Fully remote", detail: "100% remote, US time zones." };
const ON_CALL = { label: "No weekends / on-call", detail: "No pager rotation; weekends are for my kids." };
const GROWTH = { label: "Growth", detail: "A team that ships AI features I can learn from." };
const SIZE = { label: "Company size", detail: "50–500 people." };

describe("criteria tools", () => {
  let db: TestDb;
  let client: Client;

  // Teardown steps, newest first. Each is registered the moment its resource exists, and they run
  // in afterEach, so a failing setup step (migrate, connect, or the nested beforeEach that seeds
  // data) can never leave a t_* schema or an open connection behind.
  const teardown: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    const opened = await openTestDb();
    teardown.unshift(opened.cleanup);
    db = opened;
    await migrate(opened.client);
    const connected = await connect(opened.client);
    teardown.unshift(connected.close);
    client = connected.client;
  });

  afterEach(async () => {
    // Run every step even if one fails, then report the first failure.
    const errors: unknown[] = [];
    for (const step of teardown.splice(0)) {
      try {
        await step();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
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

  async function callOk(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await call(name, args);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result.structuredContent ?? {};
  }

  async function callError(name: string, args: Record<string, unknown>, on: Client = client): Promise<string> {
    const result = await call(name, args, on);
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? "";
  }

  async function savedRows(): Promise<Row[]> {
    const rows = await db.client.query<Row>("SELECT position, label, detail FROM criteria ORDER BY position");
    return rows.rows;
  }

  /** The tool result's list without timestamps, to compare with plain objects. */
  function withoutTimes(result: Record<string, unknown>): Row[] {
    return (result.criteria as (Row & { updated_at: string })[]).map(({ position, label, detail }) => ({
      position,
      label,
      detail,
    }));
  }

  describe("list_criteria_suggestions", () => {
    it("returns the 12 starter criteria as { key, label, example }", async () => {
      const result = await callOk("list_criteria_suggestions", {});

      expect(result).toEqual({ suggestions: CRITERIA_SUGGESTIONS.map(({ key, label, example }) => ({ key, label, example })) });
      expect(result.suggestions).toHaveLength(12);
    });

    it("also returns the list as JSON text, for chat apps that ignore structured results", async () => {
      const result = await call("list_criteria_suggestions", {});
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
    });
  });

  describe("set_criteria", () => {
    it("saves 1 criterion at position 1 and returns the saved list", async () => {
      const result = await callOk("set_criteria", { criteria: [PAY] });

      expect(withoutTimes(result)).toEqual([{ position: 1, ...PAY }]);
      expect(await savedRows()).toEqual([{ position: 1, ...PAY }]);
    });

    it("saves 5 criteria at positions 1..5 in the order given", async () => {
      const five = [SIZE, PAY, GROWTH, REMOTE, ON_CALL];
      const result = await callOk("set_criteria", { criteria: five });

      const expected = five.map((c, i) => ({ position: i + 1, ...c }));
      expect(withoutTimes(result)).toEqual(expected);
      expect(await savedRows()).toEqual(expected);
    });

    it("returns updated_at as the database's ISO timestamp", async () => {
      const result = await callOk("set_criteria", { criteria: [PAY, REMOTE] });
      const db_times = await db.client.query<{ updated_at: Date }>("SELECT updated_at FROM criteria ORDER BY position");

      const times = (result.criteria as { updated_at: string }[]).map((c) => c.updated_at);
      expect(times).toEqual(db_times.rows.map((r) => r.updated_at.toISOString()));
    });

    it("REPLACES the whole set: a smaller save leaves no old rows behind", async () => {
      await callOk("set_criteria", { criteria: [PAY, REMOTE, ON_CALL, GROWTH] });
      const result = await callOk("set_criteria", { criteria: [GROWTH, SIZE] });

      const expected = [
        { position: 1, ...GROWTH },
        { position: 2, ...SIZE },
      ];
      expect(withoutTimes(result)).toEqual(expected);
      expect(await savedRows()).toEqual(expected);
    });

    it("stores labels and details trimmed at the ends, with the words exactly as written", async () => {
      await callOk("set_criteria", {
        criteria: [{ label: "  Pay floor ", detail: "\nBase pay of at least $140k — ideally 180k 😀.  " }],
      });
      expect(await savedRows()).toEqual([
        { position: 1, label: "Pay floor", detail: "Base pay of at least $140k — ideally 180k 😀." },
      ]);
    });

    it("stores labels with joiners, direction marks and tag characters exactly as sent", async () => {
      const labels = [
        "\u{1F469}\u200D\u{1F4BB} Remote",
        "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
        "\u05E9\u05DB\u05E8 \u200F100k",
        "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Office",
      ];
      await callOk("set_criteria", { criteria: labels.map((label) => ({ label, detail: "ok" })) });

      expect((await savedRows()).map((r) => r.label)).toEqual(labels);
    });

    it("accepts a 300-character detail and an 80-character label", async () => {
      await callOk("set_criteria", { criteria: [{ label: "L".repeat(80), detail: "d".repeat(300) }] });
      expect(await savedRows()).toEqual([{ position: 1, label: "L".repeat(80), detail: "d".repeat(300) }]);
    });

    // Every rejection must leave the previously saved set exactly as it was.
    describe("rejections keep the saved set untouched", () => {
      beforeEach(async () => {
        await callOk("set_criteria", { criteria: [PAY, REMOTE] });
      });

      const before: Row[] = [
        { position: 1, ...PAY },
        { position: 2, ...REMOTE },
      ];

      it.each([
        ["an empty list", [], "Send at least 1 criterion (up to 5)."],
        [
          "6 criteria",
          [PAY, REMOTE, ON_CALL, GROWTH, SIZE, { label: "Benefits", detail: "Good health insurance." }],
          "You sent 6 criteria; the limit is 5. Keep the 5 that matter most.",
        ],
        [
          "an empty label",
          [PAY, { label: " ", detail: "Something." }],
          'Criterion 2 needs a label: a short name like "Pay floor".',
        ],
        [
          "an empty detail",
          [{ label: "Growth", detail: "" }],
          "Criterion 1 needs a detail: what it means to you, in your own words.",
        ],
        [
          "an 81-character label",
          [{ label: "L".repeat(81), detail: "ok" }],
          "Criterion 1's label is 81 characters; the limit is 80. Keep the label short and put the rest in the detail.",
        ],
        [
          "a 301-character detail",
          [PAY, REMOTE, { label: "Growth", detail: "d".repeat(301) }],
          "Criterion 3's detail is 301 characters; the limit is 300. Keep the part that matters most.",
        ],
        [
          "duplicate labels (case-insensitive)",
          [PAY, { label: "PAY FLOOR", detail: "Other words." }],
          'Criteria 1 and 2 have the same label ("Pay floor"). Give each one its own label.',
        ],
        [
          "raw file bytes",
          [{ label: "Pay floor", detail: "%PDF\u0000\u0001" }],
          "Criterion 1 looks like a file's raw contents, not text. Write it in your own words.",
        ],
      ])("rejects %s with a clear sentence", async (_name, criteria, message) => {
        expect(await callError("set_criteria", { criteria })).toBe(message);
        expect(await savedRows()).toEqual(before);
      });

      // A wrong TYPE can only come from the AI's tool call, so it gets the SDK's own message
      // (DECISIONS.md, PR #2 decision 2).
      it.each([
        ["no criteria field", {}, "expected array"],
        ["criteria as a string", { criteria: "Pay floor" }, "expected array"],
        ["an item without a detail", { criteria: [{ label: "Pay floor" }] }, "expected string"],
        ["a number as a label", { criteria: [{ label: 7, detail: "x" }] }, "expected string"],
      ])("rejects %s with the SDK's type error", async (_name, args, expected) => {
        const message = await callError("set_criteria", args);
        expect(message).toContain("Input validation error");
        expect(message).toContain(expected);
        expect(await savedRows()).toEqual(before);
      });

      it("is atomic: if the database fails part-way through the save, the old set is still there", async () => {
        // A real Postgres trigger in this test's own schema makes the INSERT fail on one label,
        // AFTER the old rows were deleted in the same transaction. If delete + insert were not in
        // one transaction, the old set would be gone.
        await db.client.query(`
          CREATE FUNCTION fail_on_boom() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.label = 'Boom' THEN RAISE EXCEPTION 'simulated failure'; END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER criteria_boom BEFORE INSERT ON criteria FOR EACH ROW EXECUTE FUNCTION fail_on_boom();
        `);

        const message = await callError("set_criteria", { criteria: [GROWTH, { label: "Boom", detail: "x" }] });

        expect(message).toContain("simulated failure");
        expect(await savedRows()).toEqual(before);
      });
    });

    it("two saves at the same moment: the result is one whole set, never a mix of both", async () => {
      // A pool gives the server several connections, so the saves really run in parallel.
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: `-c search_path=${db.schema}`, max: 4 });
      const parallel = await connect(pool);
      try {
        const setA = [PAY, REMOTE, ON_CALL];
        const setB = [GROWTH, SIZE];
        const results = await Promise.all(
          [setA, setB, setA, setB].map((criteria) => call("set_criteria", { criteria }, parallel.client)),
        );

        for (const result of results) expect(result.isError, result.content[0]?.text).toBeFalsy();
        const rows = (await savedRows()).map(({ label, detail }) => ({ label, detail }));
        expect([setA, setB]).toContainEqual(rows);
      } finally {
        await parallel.close();
        await pool.end();
      }
    });
  });

  describe("get_criteria", () => {
    it("returns an empty list when nothing is saved", async () => {
      expect(await callOk("get_criteria", {})).toEqual({ criteria: [] });
    });

    it("returns the saved list in position order, the same as set_criteria returned", async () => {
      const saved = await callOk("set_criteria", { criteria: [ON_CALL, PAY, REMOTE] });

      const result = await callOk("get_criteria", {});

      expect(result).toEqual(saved);
      expect(withoutTimes(result).map((c) => c.label)).toEqual([ON_CALL.label, PAY.label, REMOTE.label]);
    });

    it("sorts by position, not by the order rows were stored in", async () => {
      // Raw SQL, so the rows are stored out of order (set_criteria always inserts 1..n in order).
      await db.client.query(
        `INSERT INTO criteria (position, label, detail) VALUES
           (3, 'Third', 'c'), (1, 'First', 'a'), (5, 'Fifth', 'e'), (2, 'Second', 'b'), (4, 'Fourth', 'd')`,
      );
      // Rewrite the rows in place so their physical order differs from position order too.
      await db.client.query("UPDATE criteria SET detail = detail || '!' WHERE position IN (1, 2)");

      const result = await callOk("get_criteria", {});

      expect(withoutTimes(result)).toEqual([
        { position: 1, label: "First", detail: "a!" },
        { position: 2, label: "Second", detail: "b!" },
        { position: 3, label: "Third", detail: "c" },
        { position: 4, label: "Fourth", detail: "d" },
        { position: 5, label: "Fifth", detail: "e" },
      ]);
    });

    it("returns only the latest set after a replace", async () => {
      await callOk("set_criteria", { criteria: [PAY, REMOTE, ON_CALL] });
      await callOk("set_criteria", { criteria: [SIZE] });

      expect(withoutTimes(await callOk("get_criteria", {}))).toEqual([{ position: 1, ...SIZE }]);
    });
  });

  describe("when the database is down", () => {
    it("answers with a sentence naming host and port, never the password", async () => {
      const downUrl = "postgres://jobsearch:s3cret-pw@127.0.0.1:1/jobsearch_test";
      const pool = new pg.Pool({ connectionString: downUrl });
      const down = await connect(pool, downUrl);
      try {
        for (const [name, args] of [
          ["set_criteria", { criteria: [PAY] }],
          ["get_criteria", {}],
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

    it("still lists the suggestions (they don't need the database)", async () => {
      const downUrl = "postgres://jobsearch:s3cret-pw@127.0.0.1:1/jobsearch_test";
      const pool = new pg.Pool({ connectionString: downUrl });
      const down = await connect(pool, downUrl);
      try {
        const result = await call("list_criteria_suggestions", {}, down.client);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.suggestions).toHaveLength(12);
      } finally {
        await down.close();
        await pool.end();
      }
    });
  });
});
