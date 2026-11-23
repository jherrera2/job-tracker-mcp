import { describe, expect, it } from "vitest";
import { assertTestDatabaseUrl } from "../support/test-db-guard.js";

describe("assertTestDatabaseUrl (stops integration tests from touching real data)", () => {
  it("allows a database whose name ends in _test and returns the name", () => {
    expect(assertTestDatabaseUrl("postgres://u:p@localhost:5432/jobsearch_test")).toBe("jobsearch_test");
  });

  it("refuses the dev database", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/jobsearch")).toThrow(/_test/);
  });

  it("refuses a URL with no database name", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432")).toThrow(/_test/);
  });

  it("refuses a name that only contains _test in the middle", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/jobsearch_test_copy")).toThrow(/_test/);
  });

  it("refuses _test hidden in the query string or the #fragment", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/jobsearch?x=_test")).toThrow(/_test/);
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/jobsearch#_test")).toThrow(/_test/);
  });

  it("refuses a query parameter that tries to pick another database", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/jobsearch_test?database=jobsearch")).toThrow(
      /database/,
    );
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost/jobsearch_test?dbname=jobsearch")).toThrow(
      /dbname/,
    );
  });

  it("does not put the password in its error message", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:hunter2-secret@localhost/jobsearch")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2-secret") as unknown }),
    );
  });
});
