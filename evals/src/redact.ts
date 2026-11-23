// Keeps secrets out of anything the evals print or write (test/unit/evals/redact.test.ts).
// Used on every error message, because an SDK error can echo what the server said back.

const ANTHROPIC_KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]+/g;
const MIN_SECRET_CHARS = 8;

export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= MIN_SECRET_CHARS) out = out.replaceAll(secret, "[redacted]");
  }
  return out.replace(ANTHROPIC_KEY_SHAPE, "[redacted]");
}
