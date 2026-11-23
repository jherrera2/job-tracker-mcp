// Runs the real `db:migrate` program as a child process against a port where nothing listens,
// to check what the user actually sees. No database needed.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runMigrateCli(env: Record<string, string>) {
  // `--import tsx` lets Node run the .ts file directly (what `npm run db:migrate` does via tsx).
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate-cli.ts"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("db:migrate when Postgres is not reachable", () => {
  const unreachable = "postgres://jobsearch:s3cret-pw@localhost:5499/jobsearch";

  it("exits 1 with a clear sentence and never prints the password", () => {
    const { exitCode, output } = runMigrateCli({ DATABASE_URL: unreachable });
    expect(exitCode).toBe(1);
    expect(output).toContain("Can't reach Postgres at localhost:5499");
    expect(output).not.toContain("s3cret-pw");
  });

  it("is not stopped by a malformed ANTHROPIC_API_KEY it doesn't use", () => {
    const { output } = runMigrateCli({ DATABASE_URL: unreachable, ANTHROPIC_API_KEY: "sk-ant with spaces" });
    expect(output).not.toContain("ANTHROPIC_API_KEY");
    expect(output).toContain("Can't reach Postgres");
  });
});
