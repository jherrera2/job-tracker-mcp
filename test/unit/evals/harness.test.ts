// The harness's pure safety check (evals/src/harness.ts): after connecting, the database actually
// reached must be a _test one, whatever the URL said.
import { describe, expect, it } from "vitest";
import { assertConnectedToTestDb, listModelTools, toModelTools } from "../../../evals/src/harness.js";

describe("assertConnectedToTestDb", () => {
  it("accepts a database whose name ends in _test", () => {
    expect(() => assertConnectedToTestDb("jobsearch_test")).not.toThrow();
  });

  it("refuses any other name, or none", () => {
    expect(() => assertConnectedToTestDb("jobsearch")).toThrow(/not a _test database/);
    expect(() => assertConnectedToTestDb("jobsearch_test_copy")).toThrow(/not a _test database/);
    expect(() => assertConnectedToTestDb(undefined)).toThrow(/not a _test database/);
  });
});

describe("the tools offered to the model", () => {
  it("are the server's real get_fit_inputs and save_fit, without the JSON-Schema $schema key", async () => {
    const tools = await listModelTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_fit_inputs", "save_fit"]);
    for (const tool of tools) {
      expect((tool.description ?? "").length).toBeGreaterThan(20);
      expect(tool.input_schema).not.toHaveProperty("$schema");
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("toModelTools drops other tools and $schema", () => {
    const out = toModelTools([
      { name: "save_fit", description: "d", inputSchema: { type: "object", $schema: "http://json-schema.org/draft-07/schema#", properties: {} } },
      { name: "set_status", inputSchema: { type: "object" } },
    ]);
    expect(out).toEqual([{ name: "save_fit", description: "d", input_schema: { type: "object", properties: {} } }]);
  });
});
