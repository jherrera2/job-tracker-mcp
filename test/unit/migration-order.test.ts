import { describe, expect, it } from "vitest";
import { pendingMigrations } from "../../src/db/migrate.js";

// The directory listing order is not guaranteed (macOS happens to sort it, Linux often doesn't),
// so the ordering rule is tested on its own with a deliberately shuffled list.
describe("pendingMigrations", () => {
  it("sorts by the leading number, not by the order the folder returned", () => {
    const fromDisk = ["003_c.sql", "001_a.sql", "002_b.sql"];
    expect(pendingMigrations(fromDisk, new Set())).toEqual(["001_a.sql", "002_b.sql", "003_c.sql"]);
  });

  it("compares numbers as numbers, so 1000_ comes after 999_", () => {
    const fromDisk = ["1000_later.sql", "999_earlier.sql"];
    expect(pendingMigrations(fromDisk, new Set())).toEqual(["999_earlier.sql", "1000_later.sql"]);
  });

  it("ignores files that are not .sql", () => {
    expect(pendingMigrations(["README.md", "001_a.sql", ".DS_Store"], new Set())).toEqual(["001_a.sql"]);
  });

  it("leaves out files already applied", () => {
    const applied = new Set(["001_a.sql"]);
    expect(pendingMigrations(["002_b.sql", "001_a.sql"], applied)).toEqual(["002_b.sql"]);
  });

  it("refuses a .sql file whose name does not start with a number and an underscore", () => {
    expect(() => pendingMigrations(["001_a.sql", "add_index.sql"], new Set())).toThrow(/add_index\.sql/);
  });

  it("refuses a bad name even when it is the only .sql file (sort() skips the comparator then)", () => {
    expect(() => pendingMigrations(["add_index.sql"], new Set())).toThrow(/add_index\.sql/);
  });

  it("refuses a bad name even when that file was already applied", () => {
    expect(() => pendingMigrations(["add_index.sql"], new Set(["add_index.sql"]))).toThrow(/add_index\.sql/);
  });
});
