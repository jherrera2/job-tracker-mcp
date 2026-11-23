import { describe, expect, it } from "vitest";
import { explainDatabaseError } from "../../src/db/db-errors.js";

const URL_WITH_SECRET = "postgres://jobsearch:s3cret-pw@localhost:5499/jobsearch";

// What node-postgres throws when nothing listens on the port: an AggregateError with an EMPTY
// message (one inner error per address it tried, IPv6 and IPv4).
function connectionRefused(): AggregateError {
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5499"), { code: "ECONNREFUSED" });
  return Object.assign(new AggregateError([inner, inner], ""), { code: "ECONNREFUSED" });
}

describe("explainDatabaseError", () => {
  it("turns 'connection refused' into a sentence naming host and port", () => {
    const message = explainDatabaseError(connectionRefused(), URL_WITH_SECRET);
    expect(message).toContain("localhost:5499");
    expect(message).toContain("docker compose up -d");
  });

  it("explains an unknown host", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND nosuchhost"), { code: "ENOTFOUND" });
    const message = explainDatabaseError(err, "postgres://u:s3cret-pw@nosuchhost:5432/x");
    expect(message).toContain("nosuchhost:5432");
  });

  it("uses the default port 5432 when the URL has none", () => {
    expect(explainDatabaseError(connectionRefused(), "postgres://u:p@db.local/x")).toContain("db.local:5432");
  });

  it("passes other errors through with their own message", () => {
    expect(explainDatabaseError(new Error('relation "x" does not exist'), URL_WITH_SECRET)).toBe(
      'relation "x" does not exist',
    );
  });

  it("never returns an empty message", () => {
    expect(explainDatabaseError(new AggregateError([], ""), URL_WITH_SECRET).trim()).not.toBe("");
    expect(explainDatabaseError("weird", URL_WITH_SECRET).trim()).not.toBe("");
  });

  it("never includes the password", () => {
    const cases: unknown[] = [connectionRefused(), new Error(""), new AggregateError([], ""), undefined];
    for (const err of cases) {
      expect(explainDatabaseError(err, URL_WITH_SECRET)).not.toContain("s3cret-pw");
    }
  });
});
