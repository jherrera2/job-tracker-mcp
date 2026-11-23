import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, loadDatabaseConfig } from "../../src/config.js";

// A fake key that would be easy to spot if it ever leaked into a message.
const FAKE_KEY = "sk-ant-TEST-do-not-leak-1234567890";
const GOOD_DB_URL = "postgres://user:pw@localhost:5432/jobsearch";

// Run fn, return the error it throws (fails the test if it doesn't throw).
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error("Thrown value was not an Error", { cause: err });
  }
  throw new Error("Expected a throw, but nothing was thrown");
}

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the database URL and the key when both are valid", () => {
    const config = loadConfig({ DATABASE_URL: GOOD_DB_URL, ANTHROPIC_API_KEY: FAKE_KEY });
    expect(config.databaseUrl).toBe(GOOD_DB_URL);
    expect(config.anthropicApiKey).toBe(FAKE_KEY);
  });

  it("accepts postgresql:// as well as postgres://", () => {
    const url = "postgresql://user:pw@localhost:5432/jobsearch";
    expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
  });

  it("treats ANTHROPIC_API_KEY as optional at this step", () => {
    const config = loadConfig({ DATABASE_URL: GOOD_DB_URL });
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it("treats an empty ANTHROPIC_API_KEY (as in .env.example) as not set", () => {
    const config = loadConfig({ DATABASE_URL: GOOD_DB_URL, ANTHROPIC_API_KEY: "" });
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it("throws a ConfigError naming DATABASE_URL when it is missing", () => {
    const err = captureError(() => loadConfig({}));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("DATABASE_URL");
  });

  it("says where to set DATABASE_URL both for the npm scripts (.env) and for a chat app (its config's env block)", () => {
    const err = captureError(() => loadConfig({}));
    expect(err.message).toContain(".env");
    expect(err.message).toMatch(/env block of your chat app's config/);
    expect(err.message).not.toMatch(/^DATABASE_URL is missing\. Copy \.env\.example to \.env and set it\.$/);
  });

  it("throws a ConfigError naming DATABASE_URL when it is an empty string", () => {
    const err = captureError(() => loadConfig({ DATABASE_URL: "" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("DATABASE_URL");
  });

  it("throws a ConfigError when DATABASE_URL is not a postgres URL, without echoing it", () => {
    const badUrl = "mysql://secret-user:secret-pw@db/x";
    const err = captureError(() => loadConfig({ DATABASE_URL: badUrl }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("DATABASE_URL");
    expect(err.message).not.toContain("secret-pw");
  });

  it("keeps the error message short (one or two sentences, no stack of Zod JSON)", () => {
    const err = captureError(() => loadConfig({}));
    expect(err.message.length).toBeLessThan(200);
    expect(err.message).not.toContain("{");
  });

  describe("the API key never leaks", () => {
    it("is not in the error when another variable is missing", () => {
      const err = captureError(() => loadConfig({ ANTHROPIC_API_KEY: FAKE_KEY }));
      expect(err.message).not.toContain(FAKE_KEY);
      expect(String(err.stack)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(err)).not.toContain(FAKE_KEY);
    });

    it("is not in the error when the key itself is malformed", () => {
      const badKey = `${FAKE_KEY} \n`;
      const err = captureError(() =>
        loadConfig({ DATABASE_URL: GOOD_DB_URL, ANTHROPIC_API_KEY: badKey }),
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain("ANTHROPIC_API_KEY");
      expect(err.message).not.toContain(FAKE_KEY);
      expect(String(err.stack)).not.toContain(FAKE_KEY);
    });

    it("is not written to the console, on success or on failure", () => {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      );

      loadConfig({ DATABASE_URL: GOOD_DB_URL, ANTHROPIC_API_KEY: FAKE_KEY });
      captureError(() => loadConfig({ ANTHROPIC_API_KEY: FAKE_KEY }));

      const everythingLogged = spies.flatMap((spy) => spy.mock.calls).flat().map(String).join("\n");
      expect(everythingLogged).not.toContain(FAKE_KEY);
    });
  });
});

describe("loadDatabaseConfig (for tools that only need the database, like db:migrate)", () => {
  it("returns the database URL", () => {
    expect(loadDatabaseConfig({ DATABASE_URL: GOOD_DB_URL })).toEqual({ databaseUrl: GOOD_DB_URL });
  });

  it("ignores a malformed ANTHROPIC_API_KEY it doesn't need", () => {
    const config = loadDatabaseConfig({ DATABASE_URL: GOOD_DB_URL, ANTHROPIC_API_KEY: "has spaces in it" });
    expect(config.databaseUrl).toBe(GOOD_DB_URL);
    expect(JSON.stringify(config)).not.toContain("has spaces");
  });

  it("still names DATABASE_URL when it is missing", () => {
    const err = captureError(() => loadDatabaseConfig({}));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("DATABASE_URL");
  });
});
