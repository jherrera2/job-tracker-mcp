// Builds the MCP server and registers its tools.
//
// Creating the server is kept separate from starting it (src/index.ts), so tests can
// connect to it in memory without spawning a process.
//
// The database is passed in (constructor injection, as in .NET): src/index.ts hands over a real
// connection pool, and the integration tests hand over a connection to a throwaway test schema.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCriteriaTools } from "./tools/criteria-tools.js";
import { registerFitTools } from "./tools/fit-tools.js";
import { registerJobTools, type JobToolDeps } from "./tools/job-tools.js";
import { registerMasterResumeTools } from "./tools/master-resume-tools.js";
import { registerPromptTools } from "./tools/prompt-tools.js";

/**
 * What the server needs from outside: the database, its URL for error messages, and (tests only)
 * a stand-in for fetch so add_job reads recorded ATS fixtures instead of the network.
 */
export type ServerDeps = JobToolDeps;

interface PackageInfo {
  name: string;
  version: string;
}

// `import.meta.url` is this file's own location (like Assembly.Location in .NET).
// package.json is one folder up from both src/server.ts and the compiled dist/server.js.
function readPackageInfo(): PackageInfo {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const { name, version } = JSON.parse(raw) as PackageInfo;
  return { name, version };
}

export function createServer(deps: ServerDeps): McpServer {
  const { name, version } = readPackageInfo();
  const server = new McpServer(
    { name, version },
    {
      // Declaring the tools capability up front means `tools/list` works (and returns [])
      // even before any tool is registered.
      capabilities: { tools: {} },
    },
  );

  registerMasterResumeTools(server, deps);
  registerCriteriaTools(server, deps);
  registerPromptTools(server, deps);
  registerFitTools(server, deps);
  registerJobTools(server, deps);
  return server;
}
