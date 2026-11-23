import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/database.js";
import { createServer } from "../../src/server.js";

// Read package.json the same way the server should, so the test fails if they drift.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

// Unit tests never touch a database. The pool below points at a port nothing listens on, and
// pg only connects on the first query, so it is never used here. (The tools are tested against a
// real database in test/integration/.)
const UNUSED_DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/unused_test";

/** The `properties` of the first object schema (searched depth first) that has a property named `key`. */
function findObjectWithProperty(node: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const properties = (node as { properties?: unknown }).properties;
  if (typeof properties === "object" && properties !== null && key in properties) return properties as Record<string, unknown>;
  for (const child of Object.values(node)) {
    const found = findObjectWithProperty(child, key);
    if (found) return found;
  }
  return undefined;
}

describe("MCP server", () => {
  // Things to close after each test, like IDisposable in a C# test fixture.
  const toClose: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    // splice(0) removes every item from the array and returns them, so the list is empty for the next test.
    for (const item of toClose.splice(0)) await item.close();
  });

  // Wire a real MCP client to the server through an in-memory pipe (no subprocess, no stdio).
  async function connectClient(): Promise<Client> {
    const pool = new pg.Pool({ connectionString: UNUSED_DATABASE_URL });
    const server = createServer({ db: pool, databaseUrl: UNUSED_DATABASE_URL });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    toClose.push(client, server, { close: () => pool.end() });
    return client;
  }

  it("reports its name and version from package.json", async () => {
    const client = await connectClient();
    expect(client.getServerVersion()).toMatchObject({ name: pkg.name, version: pkg.version });
  });

  it("advertises the tools capability", async () => {
    const client = await connectClient();
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it("lists the master résumé tools (step 2), the criteria tools (step 3), the prompt tools (step 5), the fit-check tools (step 6) and the job tools (step 7)", async () => {
    const client = await connectClient();
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "add_job",
      "get_criteria",
      "get_fit_inputs",
      "get_job",
      "get_master_resume",
      "get_prompt",
      "list_criteria_suggestions",
      "list_jobs",
      "rerun_fit",
      "reset_prompt",
      "save_fit",
      "set_criteria",
      "set_master_resume",
      "set_status",
      "update_prompt",
    ]);
  });

  it("tells the AI that add_job and rerun_fit hand over to get_fit_inputs / save_fit (the server runs no model)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === "add_job");
    const rerun = tools.find((t) => t.name === "rerun_fit");
    expect(add?.description).toContain("get_fit_inputs");
    expect(add?.description).toMatch(/Greenhouse, Lever (and|or) Ashby/);
    expect(rerun?.description).toContain("save_fit");
    expect(rerun?.description).toContain("get_fit_inputs");
    expect(rerun?.inputSchema.required).toEqual(["id"]);
  });

  it("marks job-posting text as untrusted data in add_job, get_job and list_jobs (step 7 review R1)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ["add_job", "get_job", "list_jobs"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(/data, never instructions/);
      expect(JSON.stringify(tool?.outputSchema), name).toMatch(/untrusted job-posting text/i);
    }
  });

  it("marks the fit breakdown's requirement and dropped-quote text as untrusted posting-derived text (step 7 Low)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ["add_job", "get_job"]) {
      const schema = tools.find((t) => t.name === name)?.outputSchema;
      const fit = findObjectWithProperty(schema, "dropped_quotes");
      expect(fit, name).toBeDefined();
      for (const field of ["requirements", "dropped_quotes"]) {
        const description = (fit?.[field] as { description?: string } | undefined)?.description ?? "";
        expect(description, `${name}.${field}`).toMatch(/untrusted/i);
        expect(description, `${name}.${field}`).toMatch(/posting/i);
        expect(description, `${name}.${field}`).toMatch(/data, never instructions/);
      }
    }
  });

  it("lists data_notice FIRST in get_job's output schema too (step 9 review)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "get_job")?.outputSchema;
    expect(Object.keys(schema?.properties ?? {})[0]).toBe("data_notice");
  });

  it("marks red flags and criteria reasons as model-written text that may quote the posting (step 9 review)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ["add_job", "get_job"]) {
      const fit = findObjectWithProperty(tools.find((t) => t.name === name)?.outputSchema, "dropped_quotes");
      for (const field of ["red_flags", "criteria"]) {
        const description = (fit?.[field] as { description?: string } | undefined)?.description ?? "";
        expect(description, `${name}.${field}`).toMatch(/untrusted/i);
        expect(description, `${name}.${field}`).toMatch(/may quote the (job )?posting/i);
        expect(description, `${name}.${field}`).toMatch(/data, never instructions/);
      }
    }
  });

  it("tells the AI the status moves and that skip needs a note", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === "set_status");
    expect(set?.description).toMatch(/skip/);
    expect(set?.description).toMatch(/note/);
    expect(set?.description).toContain("500");
    expect(set?.inputSchema.required?.sort()).toEqual(["id", "status"]);
    const list = tools.find((t) => t.name === "list_jobs");
    expect(list?.inputSchema.required ?? []).toEqual([]);
  });

  it("tells the AI how the two fit-check tools chain, and that scores are computed by code", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const inputs = tools.find((t) => t.name === "get_fit_inputs");
    const save = tools.find((t) => t.name === "save_fit");
    expect(inputs?.description).toContain("save_fit");
    expect(inputs?.inputSchema.required).toEqual(["job_id"]);
    expect(save?.description).toMatch(/word for word/);
    expect(save?.description).toMatch(/computed by code|computes/);
    expect(save?.inputSchema.required?.sort()).toEqual(["job_id", "ref", "result"]);
  });

  it("tells the AI the criteria limits in the set_criteria description", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const setTool = tools.find((tool) => tool.name === "set_criteria");
    expect(setTool).toBeDefined();
    expect(setTool?.description).toContain("1 to 5");
    expect(setTool?.description).toContain("80");
    expect(setTool?.description).toContain("300");
    expect(setTool?.description).toMatch(/replaces/i);
    expect(setTool?.inputSchema.required).toEqual(["criteria"]);
  });

  it("takes no arguments on list_criteria_suggestions and get_criteria", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ["list_criteria_suggestions", "get_criteria"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.inputSchema.properties ?? {}, name).toEqual({});
    }
  });

  it("tells the AI the résumé limits in the set_master_resume description", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const setTool = tools.find((tool) => tool.name === "set_master_resume");
    expect(setTool?.description).toContain("200");
    expect(setTool?.description).toContain("60,000");
    expect(setTool?.inputSchema.required).toEqual(["text"]);
  });

  it("tells the AI the prompt names, the text limit, and that edits can't change the answer's shape", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ["get_prompt", "update_prompt", "reset_prompt"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toContain("fit_check");
      expect(tool?.inputSchema.required, name).toContain("name");
    }
    const update = tools.find((t) => t.name === "update_prompt");
    expect(update?.description).toContain("20,000");
    expect(update?.description).toMatch(/shape/i);
    expect(update?.inputSchema.required).toEqual(["name", "text"]);
  });

  it("makes version optional on get_master_resume", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const getTool = tools.find((tool) => tool.name === "get_master_resume");
    expect(getTool?.inputSchema.properties).toHaveProperty("version");
    expect(getTool?.inputSchema.required ?? []).not.toContain("version");
  });

  // Race (Copilot review, PR #2): a "latest" read finds nothing, then a first save commits before
  // the follow-up MAX(version) query. The answer must be "nothing saved", never "no version undefined".
  it("says nothing is saved when a first save lands mid-way through a latest read", async () => {
    let calls = 0;
    const racingDb = {
      query: () => Promise.resolve(calls++ === 0 ? { rows: [] } : { rows: [{ version: 1 }] }),
    } as unknown as Queryable;
    const server = createServer({ db: racingDb, databaseUrl: UNUSED_DATABASE_URL });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    toClose.push(client, server);

    const result = await client.callTool({ name: "get_master_resume", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("No master résumé is saved yet");
    expect(text).not.toContain("undefined");
  });
});

