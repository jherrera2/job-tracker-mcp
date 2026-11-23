// Entry point: start the MCP server over stdio (how Claude Desktop, Cursor, etc. launch it).
//
// stdout carries the MCP protocol itself, so anything we want to say goes to stderr
// (console.error), never console.log.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/database.js";
import { createServer } from "./server.js";

try {
  // Fails fast with a short sentence if DATABASE_URL (or the AI key) is missing or malformed.
  const config = loadConfig();
  // The pool connects lazily, so the server starts even if Postgres is down; each tool call then
  // answers "Can't reach Postgres at ..." instead of the server crashing on start.
  const pool = createPool(config.databaseUrl);
  const server = createServer({ db: pool, databaseUrl: config.databaseUrl });
  await server.connect(new StdioServerTransport());
  console.error("job-tracker-mcp is running on stdio.");
} catch (err) {
  // Config errors are already short, fixed sentences (see src/config.ts).
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
