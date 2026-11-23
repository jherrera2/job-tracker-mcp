// Reads settings from environment variables and validates them with Zod.
//
// This file never reads .env itself: the npm scripts pass `--env-file-if-exists=.env` to Node,
// and in Claude Desktop the variables come from its config. Here we only check what arrived.
//
// Secrets rule: error messages are fixed strings written below. They name the variable,
// never its value, so a key or a database password can't end up in an error or a log.
import { z } from "zod";

// What every database-using command needs.
const DatabaseEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is missing. For the npm scripts, copy .env.example to .env and set it there; for a chat app, set it in the env block of your chat app's config." })
    .regex(/^postgres(ql)?:\/\//, {
      error: "DATABASE_URL must start with postgres:// or postgresql://.",
    }),
});

// Everything the MCP server needs: the database plus the AI key.
const EnvSchema = DatabaseEnvSchema.extend({
  // Optional until the fit-check step needs it.
  ANTHROPIC_API_KEY: z
    .string()
    .regex(/^\S+$/, {
      error: "ANTHROPIC_API_KEY contains spaces or line breaks. Paste the key again.",
    })
    .optional(),
});

export interface DatabaseConfig {
  databaseUrl: string;
}

export interface Config extends DatabaseConfig {
  anthropicApiKey: string | undefined;
}

/** Thrown when the environment is missing something or has a bad value. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parses with `schema`; on failure throws a ConfigError built only from our own fixed messages. */
function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // The Zod error (which holds the input values) is dropped on purpose.
    throw new ConfigError(result.error.issues.map((issue) => issue.message).join(" "));
  }
  return result.data;
}

// An empty value (e.g. `ANTHROPIC_API_KEY=` straight from .env.example) counts as "not set".
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * Validates the environment and returns typed settings for the MCP server.
 * `env` defaults to the real process environment; tests pass a plain object instead.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = parseOrThrow(EnvSchema, {
    DATABASE_URL: emptyToUndefined(env.DATABASE_URL),
    ANTHROPIC_API_KEY: emptyToUndefined(env.ANTHROPIC_API_KEY),
  });
  return { databaseUrl: data.DATABASE_URL, anthropicApiKey: data.ANTHROPIC_API_KEY };
}

/** Only the database settings (used by `db:migrate`, which never touches the AI key). */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const data = parseOrThrow(DatabaseEnvSchema, { DATABASE_URL: emptyToUndefined(env.DATABASE_URL) });
  return { databaseUrl: data.DATABASE_URL };
}
