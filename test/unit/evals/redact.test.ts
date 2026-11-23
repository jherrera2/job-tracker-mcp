// Secrets never reach the screen or a results file (evals/src/redact.ts).
import { describe, expect, it } from "vitest";
import { redact } from "../../../evals/src/redact.js";

describe("redact", () => {
  it("replaces every copy of a given secret", () => {
    expect(redact("key=abcdefgh12345678 again abcdefgh12345678", ["abcdefgh12345678"])).toBe(
      "key=[redacted] again [redacted]",
    );
  });

  it("also hides anything shaped like an Anthropic key, even one it wasn't told about", () => {
    expect(redact("x-api-key: sk-ant-api03-AbC_dEf-123 failed", [])).toBe("x-api-key: [redacted] failed");
  });

  it("ignores empty or very short secrets, which would blank out ordinary text", () => {
    expect(redact("a short one", ["", undefined, "a"])).toBe("a short one");
  });
});
