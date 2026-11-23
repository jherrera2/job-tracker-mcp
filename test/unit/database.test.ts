import { afterEach, describe, expect, it, vi } from "vitest";
import { createPool } from "../../src/db/database.js";

// Same idea as server.test.ts: a port nothing listens on, and nothing here ever runs a query.
const UNUSED_DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/unused_test";

describe("createPool", () => {
  afterEach(() => vi.restoreAllMocks());

  // pg emits 'error' on the pool when an idle connection dies (e.g. Postgres restarts while the
  // server sits idle). An EventEmitter 'error' with no listener crashes the Node process, so the
  // pool must handle it; the next tool call then gets a fresh connection. (Copilot review, PR #2.)
  it("survives an idle-connection error instead of crashing the process", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPool(UNUSED_DATABASE_URL);
    try {
      expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
      expect(stderr).toHaveBeenCalled();
    } finally {
      await pool.end();
    }
  });
});
